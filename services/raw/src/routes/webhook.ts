/**
 * POST /raw/webhooks/{provider}
 *
 * skipAuth (§3.1 exception — HMAC-signed, not bearer). Plaid signature
 * verified via the shared primitive; other providers return 501 until
 * their sig schemes are wired.
 *
 * A verified webhook produces one or more artifacts through the source
 * adapter, each persisted via the ingest orchestrator.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { brainError, verifyPlaidWebhook, type PlaidVerifyOptions } from "@brain/api/shared";
import { adapterForWebhookProvider } from "../adapters/registry.js";
import { ingestMany } from "../services/ingest.js";
import type { RawDeps } from "../deps.js";

/**
 * The tenant that a webhook corresponds to is derived from provider-specific
 * mapping — for Plaid: from `item_id` lookup against the Plaid Items table
 * that will land in stage-3 when extractors are built. For stage-2 we
 * require the tenant to be supplied via a signed query param or header, or
 * we use a dev-only header. The mapping helper is injected for testability.
 */
export type WebhookTenantResolver = (
  provider: string,
  body: Buffer,
  headers: Record<string, unknown>,
) => Promise<string>;

export interface WebhookRouteOptions {
  plaidVerify: PlaidVerifyOptions;
  resolveTenant: WebhookTenantResolver;
}

export async function registerWebhook(
  app: FastifyInstance,
  deps: RawDeps,
  opts: WebhookRouteOptions,
): Promise<void> {
  app.post(
    "/raw/webhooks/:provider",
    {
      config: { skipAuth: true },
      // The body must stay as a raw Buffer for HMAC/JWT verification. We
      // register a content-type parser in server.ts that preserves bytes.
    },
    async (request: FastifyRequest<{ Params: { provider: string } }>, reply) => {
      const provider = request.params.provider;
      const raw = (request.body as Buffer | undefined) ?? Buffer.alloc(0);

      if (provider === "plaid") {
        const header = request.headers["plaid-verification"];
        if (typeof header !== "string") {
          throw brainError("raw_webhook_signature_invalid", "missing Plaid-Verification header");
        }
        await verifyPlaidWebhook(raw, header, opts.plaidVerify);
      } else {
        throw brainError(
          "raw_source_unsupported",
          `webhook signature scheme for '${provider}' is not implemented yet`,
          { statusOverride: 501 },
        );
      }

      const adapter = adapterForWebhookProvider(provider);
      if (adapter.handleWebhook === undefined) {
        throw brainError(
          "raw_source_unsupported",
          `adapter '${adapter.sourceType}' has no webhook handler`,
          { statusOverride: 501 },
        );
      }

      const tenantId = await opts.resolveTenant(provider, raw, request.headers);
      const artifacts = await adapter.handleWebhook(
        tenantId,
        raw,
        request.headers as Record<string, unknown>,
      );
      const inputs = artifacts.map((a) => ({
        tenantId,
        actor: `partner_${provider}`,
        sourceType: adapter.sourceType,
        sourceRef: a.sourceRef,
        body: a.body,
        mimeType: a.mimeType,
      }));
      const results = await ingestMany(deps, inputs);

      reply.status(202);
      return { accepted: true, trace_id: request.id, artifacts: results.length };
    },
  );
}
