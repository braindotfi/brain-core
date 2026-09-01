/**
 * Brain JWT and API-key auth plugin for Fastify.
 *
 * API-key authentication also owns the gateway request-meter lifecycle. A
 * cryptographically matched key is tenant-attributable even when it is
 * revoked, expired, no longer eligible, or rate limited. Missing, malformed,
 * and unknown credentials remain separate security telemetry and are never
 * written to the tenant meter.
 */

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { brainError, isBrainError } from "../errors.js";
import { enterApiKeyId } from "../correlation.js";
import { newRequestId } from "../ids.js";
import type {
  ApiKeyAuthenticationResult,
  ApiKeyAttribution,
  ApiKeyKnownRejectionReason,
  ApiKeyRouteContract,
  ApiKeyRouteMeteringContract,
  ApiKeySecurityTelemetry,
  ApiRequestMeter,
  ApiRequestMeterOutcome,
} from "./api-key-metering.js";
import { routeContractKey, validateApiKeyRouteContracts } from "./api-key-metering.js";
import type { JwtVerifier } from "./jwt.js";
import type { Principal } from "./principal.js";

interface ApiKeyMeterRequestContext {
  /** Server-minted id. Client correlation ids are not billing idempotency keys. */
  readonly meterRequestId: string;
  readonly attribution: ApiKeyAttribution;
  readonly occurredAt: Date;
  readonly knownRejection: ApiKeyKnownRejectionReason | null;
  readonly rateLimit: {
    count: number;
    limit: number;
    tenantCount: number;
    tenantLimit: number;
    rejectedBy: "key" | "tenant" | "key_and_tenant" | null;
    tierId: string;
    entitlementVersion: number;
    windowSeconds: number;
  } | null;
  readonly rateLimitPolicy: {
    tierId: string;
    entitlementVersion: number;
    windowSeconds: number;
  } | null;
  errorCode: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Present iff the route is non-exempt and auth succeeded. */
    principal?: Principal;
    /** Present iff a first-class Brain API key authenticated the request. */
    apiKeyId?: string;
    /** Internal context used to finalize one tenant-attributed meter row. */
    apiKeyMeterContext?: ApiKeyMeterRequestContext;
  }
  interface FastifyContextConfig {
    /** Set `skipAuth: true` on a route config to bypass JWT verification. */
    skipAuth?: boolean;
    /** With skipAuth, authenticate a bearer if present but allow none. */
    optionalAuth?: boolean;
    /** Gateway-owned API-key operation and authorization metadata. */
    apiKeyMetering?: ApiKeyRouteMeteringContract;
  }
}

type LegacyApiKeyAuthenticationResult = { principal: Principal; keyId: string } | null;

export interface AuthPluginOptions {
  verifier: JwtVerifier;
  apiKeyAuthenticator?: (
    secret: string,
    context?: { requestId: string },
  ) => Promise<ApiKeyAuthenticationResult | LegacyApiKeyAuthenticationResult>;
  apiKeyRequestMeter?: ApiRequestMeter;
  apiKeySecurityTelemetry?: ApiKeySecurityTelemetry;
  apiKeyRouteContracts?: readonly ApiKeyRouteContract[];
  apiKeyRateLimitWindowSeconds?: number;
}

/**
 * CodeQL reports js/polynomial-redos here. It is a false positive against how
 * this function is reached. Node's HTTP parser rejects the CR and LF values
 * needed to make the anchored expression backtrack polynomially.
 */
const AUTH_HEADER_RE = /^Bearer\s+(.+)$/i;

export function extractBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = AUTH_HEADER_RE.exec(header.trim());
  return match !== null && match[1] !== undefined ? match[1].trim() : null;
}

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const {
    verifier,
    apiKeyAuthenticator,
    apiKeyRequestMeter,
    apiKeySecurityTelemetry,
    apiKeyRateLimitWindowSeconds,
  } = opts;
  const routeContracts = validateApiKeyRouteContracts(opts.apiKeyRouteContracts ?? []);

  fastify.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    const matches = methods
      .map((method) => findRouteContract(routeContracts, method, routeOptions.url))
      .filter((contract): contract is ApiKeyRouteMeteringContract => contract !== undefined);
    if (matches.length === 0) return;
    const first = matches[0]!;
    if (matches.some((contract) => contract.operationId !== first.operationId)) {
      throw new Error(
        `one Fastify route cannot carry multiple API key operations: ${routeOptions.url}`,
      );
    }
    routeOptions.config = { ...routeOptions.config, apiKeyMetering: first };
  });

  fastify.addHook("onRequest", async (request: FastifyRequest, reply) => {
    const skipAuth = request.routeOptions.config?.skipAuth === true;
    const optionalAuth = request.routeOptions.config?.optionalAuth === true;
    const token = extractBearer(request.headers.authorization);
    if (skipAuth && (!optionalAuth || token === null)) {
      return;
    }
    if (token === null) {
      apiKeySecurityTelemetry?.record({
        requestId: request.id,
        method: request.method,
        routeTemplate: routePattern(request),
        reason: "missing_bearer",
      });
      throw brainError("auth_token_missing", "missing bearer token");
    }
    if (token.startsWith("brain_sk_")) {
      const meterRequestId = newRequestId();
      const rawResult = await apiKeyAuthenticator?.(token, { requestId: meterRequestId });
      const result = normalizeApiKeyAuthenticationResult(rawResult, token);
      if (result.kind === "unknown_rejected") {
        apiKeySecurityTelemetry?.record({
          requestId: request.id,
          method: request.method,
          routeTemplate: routePattern(request),
          reason: result.reason,
        });
        throw brainError("auth_invalid_key", "api key invalid");
      }

      request.apiKeyMeterContext = {
        meterRequestId,
        attribution: result.attribution,
        occurredAt: new Date(),
        knownRejection: result.kind === "known_rejected" ? result.reason : null,
        rateLimit:
          result.rateLimit === undefined
            ? null
            : {
                count: result.rateLimit.count,
                limit: result.rateLimit.limit,
                tenantCount: result.rateLimit.tenantCount,
                tenantLimit: result.rateLimit.tenantLimit,
                rejectedBy: result.rateLimit.rejectedBy,
                tierId: result.rateLimit.policy.tierId,
                entitlementVersion: result.rateLimit.policy.entitlementVersion,
                windowSeconds: result.rateLimit.policy.windowSeconds,
              },
        rateLimitPolicy: result.rateLimit?.policy ?? result.rateLimitPolicy ?? null,
        errorCode: null,
      };

      if (result.rateLimit !== undefined) {
        const remaining = Math.max(
          0,
          Math.min(
            result.rateLimit.limit - result.rateLimit.count,
            result.rateLimit.tenantLimit - result.rateLimit.tenantCount,
          ),
        );
        reply.header("RateLimit-Limit", result.rateLimit.limit);
        reply.header("RateLimit-Remaining", remaining);
        reply.header("RateLimit-Reset", result.rateLimit.policy.windowSeconds);
        reply.header("X-RateLimit-Tier", result.rateLimit.policy.tierId);
        reply.header("X-RateLimit-Tenant-Limit", result.rateLimit.tenantLimit);
      }

      if (result.kind === "known_rejected") {
        if (result.reason === "rate_limited") {
          throw brainError("rate_limited", "api key rate limit exceeded", {
            details: {
              key_id: result.attribution.keyId,
              limit: result.rateLimit?.limit,
              count: result.rateLimit?.count,
              tenant_limit: result.rateLimit?.tenantLimit,
              tenant_count: result.rateLimit?.tenantCount,
              rejected_by: result.rateLimit?.rejectedBy,
            },
          });
        }
        if (result.reason === "rate_limiter_unavailable") {
          throw brainError("dependency_unavailable", "api key rate limiter unavailable", {
            details: { key_id: result.attribution.keyId },
          });
        }
        throw brainError("auth_invalid_key", "api key invalid");
      }

      request.principal = result.principal;
      request.apiKeyId = result.attribution.keyId;
      enterApiKeyId(result.attribution.keyId);
      return;
    }
    const principal = await verifier.verify(token);
    request.principal = principal;
  });

  fastify.addHook("onError", async (request, _reply, error) => {
    if (request.apiKeyMeterContext !== undefined) {
      request.apiKeyMeterContext.errorCode = isBrainError(error)
        ? error.code
        : "internal_server_error";
    }
  });

  fastify.addHook("onResponse", async (request, reply) => {
    const context = request.apiKeyMeterContext;
    if (apiKeyRequestMeter === undefined || context === undefined) return;

    const contract = request.routeOptions.config?.apiKeyMetering;
    const outcome = classifyOutcome(reply.statusCode, context.knownRejection, context.errorCode);
    try {
      await apiKeyRequestMeter.record({
        requestId: context.meterRequestId,
        tenantId: context.attribution.tenantId,
        keyId: context.attribution.keyId,
        occurredAt: context.occurredAt,
        environment: context.attribution.environment,
        accessStage: context.attribution.accessStage,
        method: request.method,
        routeTemplate: routePattern(request),
        operationId: contract?.operationId ?? "unclassified",
        requiredScope: contract?.requiredScope ?? null,
        productFamily: contract?.productFamily ?? null,
        statusCode: reply.statusCode,
        outcome,
        rejectionReason: context.knownRejection ?? context.errorCode,
        rateLimitCount: context.rateLimit?.count ?? null,
        rateLimitValue: context.rateLimit?.limit ?? null,
        rateLimitWindowSeconds:
          context.rateLimitPolicy?.windowSeconds ?? apiKeyRateLimitWindowSeconds ?? null,
        effectiveTierId: context.rateLimitPolicy?.tierId ?? null,
        entitlementVersion: context.rateLimitPolicy?.entitlementVersion ?? null,
        rateLimitTenantCount: context.rateLimit?.tenantCount ?? null,
        rateLimitTenantValue: context.rateLimit?.tenantLimit ?? null,
        rateLimitRejectedBy: context.rateLimit?.rejectedBy ?? null,
      });
    } catch (err) {
      request.log.error({ err, request_id: request.id }, "api key request meter append failed");
    }
  });
};

function normalizeApiKeyAuthenticationResult(
  result: ApiKeyAuthenticationResult | LegacyApiKeyAuthenticationResult | undefined,
  secret: string,
): ApiKeyAuthenticationResult {
  if (result === undefined) {
    return { kind: "unknown_rejected", reason: "authenticator_disabled" };
  }
  if (result === null) {
    return { kind: "unknown_rejected", reason: "unknown" };
  }
  if ("kind" in result) return result;
  return {
    kind: "authenticated",
    principal: result.principal,
    keyId: result.keyId,
    attribution: {
      keyId: result.keyId,
      tenantId: result.principal.tenantId,
      environment: secret.startsWith("brain_sk_live_") ? "live" : "sandbox",
      accessStage: null,
    },
  };
}

function findRouteContract(
  contracts: ReadonlyMap<string, ApiKeyRouteMeteringContract>,
  method: string,
  route: string,
): ApiKeyRouteMeteringContract | undefined {
  const exact = contracts.get(routeContractKey(method, route));
  if (exact !== undefined) return exact;
  const withoutVersion = route.replace(/^\/v1(?=\/)/, "");
  return contracts.get(routeContractKey(method, withoutVersion));
}

function classifyOutcome(
  statusCode: number,
  knownRejection: ApiKeyKnownRejectionReason | null,
  errorCode: string | null,
): ApiRequestMeterOutcome {
  if (knownRejection === "rate_limited" || errorCode === "rate_limited") return "rate_limited";
  if (knownRejection === "rate_limiter_unavailable") return "server_error";
  if (knownRejection !== null) return "auth_rejected";
  if (errorCode === "auth_scope_insufficient" || errorCode === "scope_insufficient") {
    return "scope_rejected";
  }
  if (statusCode >= 500) return "server_error";
  if (statusCode >= 400) return "client_error";
  return "success";
}

function routePattern(request: FastifyRequest): string {
  return request.routeOptions.url ?? "unknown";
}

export default fp(plugin, { name: "brain-auth", fastify: "5.x" });
