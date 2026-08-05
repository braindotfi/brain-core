/**
 * GET  /raw/{raw_id}/parsed  -- list parser outputs (stage-2 returns []).
 * POST /raw/{raw_id}/parsed  -- write one parser output (the stage-3 producer).
 *
 * The POST is the first writer of raw_parsed in the system. It is called by
 * extraction workers and first-party extractor agents (e.g. document_extractor)
 * and is the boundary-clean way for an agent to contribute parsed evidence:
 * Raw owns the table, the agent calls the API, and writing into Ledger stays
 * the Ledger normalize service job. The write never touches Ledger.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  brainError,
  isBrainId,
  newRawParsedId,
  requireScope,
  sha256Hex,
  withTenantScope,
  type Scope,
} from "@brain/shared";
import { findArtifactById } from "../repository/artifacts.js";
import { insertParsed, listParsedByArtifact, type RawParsedRow } from "../repository/parsed.js";
import type { RawDeps } from "../deps.js";

const READ_SCOPE: Scope = "raw:read";
const WRITE_SCOPE: Scope = "raw:write";

export interface RegisterParsedOptions {
  /**
   * Shared secret proving the caller is a trusted first-party service (a
   * Python extraction agent), not just any raw:write principal. When set AND
   * the request carries a valid X-Brain-Service-Auth v2 HMAC (see below) the
   * write lands in the signed X-Brain-Write-Tenant tenant instead of the JWT
   * request.principal.tenantId. An absent secret or a mismatched/missing/
   * expired signature leaves behavior unchanged (write to the JWT tenant,
   * untrusted). This lets a static golden-tenant agent JWT write parsed rows
   * into the caller real tenant without widening the JWT own authority.
   * Mirrors the existing api-to-agents X-Brain-Auth scheme (services/api/src/
   * agents/sign-agent-request.ts / services/agents/brain_agents/auth.py) so
   * the raw secret itself never travels on the wire, only a body-bound
   * signature.
   *
   * F4 (security fix): the write-tenant redirect used to be an UNSIGNED
   * header -- the HMAC covered only the request body, so anyone who obtained
   * one legitimately-signed body (a captured extraction callback, a proxy
   * log, a compromised agents container) could replay it with a different
   * X-Brain-Write-Tenant and land attacker-chosen content in a victim
   * tenant's Raw layer as a trusted-service row, including triggering a
   * repair (allowRepair) of an existing row. The signed material now binds
   * the timestamp and the write-tenant, not just the body, and a signature
   * outside a bounded replay window is treated as unverified. See
   * computeServiceAuthSignatureV2's header contract below -- the Python
   * signing counterpart (services/agents/brain_agents/client.py) must be
   * updated to match; it is NOT changed here (owned by another workstream).
   */
  crossTenantServiceSecret?: string;
}

/**
 * v2 signed request contract (F4). The Python client
 * (services/agents/brain_agents/client.py) must send, on every trusted-
 * service POST /raw/{raw_id}/parsed:
 *
 *   X-Brain-Service-Timestamp: <unix seconds, decimal string, generated
 *       fresh per request -- never cached or reused>
 *   X-Brain-Write-Tenant: <target tenant id, or omit the header entirely to
 *       write into the caller's own JWT tenant>
 *   X-Brain-Service-Auth: sha256v2=<hex HMAC-SHA256 of
 *       `${timestamp}.${writeTenant}.` (writeTenant = "" when the header is
 *       omitted) followed by the raw, exact request body bytes, keyed by the
 *       shared secret>
 *
 * A request signed under the OLD `sha256=hmac(secret, body)` scheme (no
 * timestamp, no tenant binding) will not verify against this computation --
 * it fails closed to an untrusted, own-tenant, no-repair write exactly like
 * a garbled signature would, it does not error. The server accepts a
 * signature only within SERVICE_AUTH_REPLAY_WINDOW_SECONDS of "now".
 */
const SERVICE_AUTH_PREFIX_V2 = "sha256v2=";
const SERVICE_AUTH_REPLAY_WINDOW_SECONDS = 300;

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `${timestamp}.${writeTenant}.` (writeTenant = "" for "no redirect
 * requested") followed by the raw request body bytes, HMAC-SHA256'd with the
 * shared secret. Binding the timestamp and tenant into the signed material
 * (not just the body) is exactly what closes F4: a captured signature can no
 * longer be replayed with a different X-Brain-Write-Tenant, because changing
 * that value invalidates the signature.
 */
export function computeServiceAuthSignatureV2(
  secret: string,
  timestamp: string,
  writeTenant: string,
  rawBody: Buffer,
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.${writeTenant}.`, "utf8");
  hmac.update(rawBody);
  return SERVICE_AUTH_PREFIX_V2 + hmac.digest("hex");
}

/**
 * Constant-time compare of a request-supplied HMAC signature against the one
 * computed over the timestamp, write-tenant, and raw body. Length-checked
 * first so timingSafeEqual (which throws on mismatched buffer lengths) never
 * sees unequal-length input. Also enforces the bounded replay window. False
 * (never throws) whenever the raw body is unavailable, the signature or
 * timestamp header is missing/malformed, the timestamp is outside the
 * replay window, or the signature does not match -- the caller always falls
 * back to the untrusted JWT-tenant write on any doubt.
 */
export function verifyServiceAuthSignatureV2(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  writeTenant: string,
  secret: string,
): boolean {
  if (rawBody === undefined) return false;
  if (signatureHeader === undefined || !signatureHeader.startsWith(SERVICE_AUTH_PREFIX_V2)) {
    return false;
  }
  if (timestampHeader === undefined || !/^[0-9]{1,15}$/.test(timestampHeader)) return false;
  const timestampSeconds = Number(timestampHeader);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SERVICE_AUTH_REPLAY_WINDOW_SECONDS) return false;
  const expected = computeServiceAuthSignatureV2(secret, timestampHeader, writeTenant, rawBody);
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader, "utf8");
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * The raw JSON content-type parser (server.ts) stashes the exact request
 * bytes on the parsed body as `__rawBody` so signature verification can run
 * over the same bytes the caller signed. Returns undefined for any other
 * shape (never throws -- an absent raw body just fails the HMAC check).
 */
function extractRawBody(body: unknown): Buffer | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidate = (body as Record<string, unknown>)["__rawBody"];
  return Buffer.isBuffer(candidate) ? candidate : undefined;
}

/**
 * Resolve which tenant a parsed write should land in, and whether the caller
 * proved it is the trusted first-party service (not just any raw:write
 * principal) via a verified v2 X-Brain-Service-Auth HMAC. Defaults to the
 * JWT principal's own tenant / untrusted. Fails closed: no configured
 * secret, or any signature/timestamp/tenant-binding mismatch, means the
 * tenant-redirect header and the trust signal are both ignored.
 *
 * `serviceAuthVerified` is also `insertParsed`'s `allowRepair` gate (H4):
 * only a caller that proved this HMAC -- i.e. the deterministic
 * re-extraction workers, never an ordinary raw:write token -- may trigger a
 * repair of an existing raw_parsed row.
 */
function resolveWriteAuthorization(
  request: FastifyRequest,
  principalTenantId: string,
  crossTenantServiceSecret: string | undefined,
): { tenantId: string; serviceAuthVerified: boolean } {
  if (crossTenantServiceSecret === undefined || crossTenantServiceSecret.length === 0) {
    return { tenantId: principalTenantId, serviceAuthVerified: false };
  }
  const signatureHeader = singleHeaderValue(request.headers["x-brain-service-auth"]);
  const timestampHeader = singleHeaderValue(request.headers["x-brain-service-timestamp"]);
  const targetTenantHeader = singleHeaderValue(request.headers["x-brain-write-tenant"]);
  // The empty string is itself the signed value for "no redirect requested"
  // -- an attacker cannot turn an untargeted signature into a targeted one
  // by simply adding the header, since "" would no longer match.
  const signedWriteTenant = targetTenantHeader ?? "";
  const rawBody = extractRawBody(request.body);
  if (
    !verifyServiceAuthSignatureV2(
      rawBody,
      signatureHeader,
      timestampHeader,
      signedWriteTenant,
      crossTenantServiceSecret,
    )
  ) {
    return { tenantId: principalTenantId, serviceAuthVerified: false };
  }
  const tenantId = signedWriteTenant.length > 0 ? signedWriteTenant : principalTenantId;
  return { tenantId, serviceAuthVerified: true };
}

export interface RawParsedWriteBody {
  parser: string;
  parser_version: string;
  extracted: Record<string, unknown>;
  confidence: number | null;
}

/**
 * Validate and normalize a POST body. Pure (no IO) so it is unit-testable
 * without a database. Throws a 400 brainError on any shape violation.
 */
export function parseRawParsedWriteBody(raw: unknown): RawParsedWriteBody {
  if (typeof raw !== "object" || raw === null) {
    throw brainError("request_body_invalid", "body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  const parser = body["parser"];
  if (typeof parser !== "string" || parser.length === 0 || parser.length > 128) {
    throw brainError("request_body_invalid", "parser must be a non-empty string (<=128 chars)");
  }
  const parserVersion = body["parser_version"];
  if (
    typeof parserVersion !== "string" ||
    parserVersion.length === 0 ||
    parserVersion.length > 64
  ) {
    throw brainError(
      "request_body_invalid",
      "parser_version must be a non-empty string (<=64 chars)",
    );
  }
  const extracted = body["extracted"];
  if (typeof extracted !== "object" || extracted === null || Array.isArray(extracted)) {
    throw brainError("request_body_invalid", "extracted must be a JSON object");
  }

  let confidence: number | null = null;
  const rawConfidence = body["confidence"];
  if (rawConfidence !== undefined && rawConfidence !== null) {
    if (typeof rawConfidence !== "number" || rawConfidence < 0 || rawConfidence > 1) {
      throw brainError("request_body_invalid", "confidence must be a number in [0, 1]");
    }
    confidence = rawConfidence;
  }

  return {
    parser,
    parser_version: parserVersion,
    extracted: extracted as Record<string, unknown>,
    confidence,
  };
}

function serializeParsed(p: RawParsedRow): Record<string, unknown> {
  return {
    id: p.id,
    raw_artifact_id: p.raw_artifact_id,
    parser: p.parser,
    parser_version: p.parser_version,
    extracted: p.extracted,
    confidence: p.confidence,
    extracted_at: p.extracted_at.toISOString(),
  };
}

export async function registerParsed(
  app: FastifyInstance,
  deps: RawDeps,
  opts: RegisterParsedOptions = {},
): Promise<void> {
  app.get(
    "/raw/:raw_id/parsed",
    async (
      request: FastifyRequest<{
        Params: { raw_id: string };
        Querystring: { parser?: string; parser_version?: string };
      }>,
      reply,
    ) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(request.principal.scopes, READ_SCOPE);

      const id = request.params.raw_id;
      if (!isBrainId(id, "raw")) {
        throw brainError("request_params_invalid", "malformed raw_id");
      }

      const result = await withTenantScope(deps.pool, request.principal.tenantId, async (c) => {
        const artifact = await findArtifactById(c, id);
        if (artifact === null) return null;
        const parsed = await listParsedByArtifact(c, id, {
          ...(request.query.parser !== undefined ? { parser: request.query.parser } : {}),
          ...(request.query.parser_version !== undefined
            ? { parserVersion: request.query.parser_version }
            : {}),
        });
        return { artifact, parsed };
      });

      if (result === null) {
        throw brainError("raw_artifact_not_found", "no such raw artifact");
      }

      reply.status(200);
      return {
        raw_id: result.artifact.id,
        parsed: result.parsed.map(serializeParsed),
      };
    },
  );

  app.post(
    "/raw/:raw_id/parsed",
    async (request: FastifyRequest<{ Params: { raw_id: string }; Body: unknown }>, reply) => {
      if (request.principal === undefined) {
        throw brainError("auth_token_missing", "principal required");
      }
      requireScope(request.principal.scopes, WRITE_SCOPE);

      const id = request.params.raw_id;
      if (!isBrainId(id, "raw")) {
        throw brainError("request_params_invalid", "malformed raw_id");
      }

      const body = parseRawParsedWriteBody(request.body);
      const { tenantId: writeTenantId, serviceAuthVerified } = resolveWriteAuthorization(
        request,
        request.principal.tenantId,
        opts.crossTenantServiceSecret,
      );
      const actor = request.principal.id;

      const result = await withTenantScope(deps.pool, writeTenantId, async (c) => {
        const artifact = await findArtifactById(c, id);
        if (artifact === null) return { kind: "not_found" as const };
        if (artifact.tombstoned_at !== null) return { kind: "tombstoned" as const };
        const { row, created } = await insertParsed(c, {
          id: newRawParsedId(),
          rawArtifactId: id,
          tenantId: writeTenantId,
          parser: body.parser,
          parserVersion: body.parser_version,
          extracted: body.extracted,
          confidence: body.confidence,
          // H4/H2: repair is trusted-caller-only. The HMAC-verified service
          // call (document_extractor et al, via X-Brain-Service-Auth) may
          // repair a stranded/corrected row; an ordinary raw:write token may
          // not -- see resolveWriteAuthorization.
          allowRepair: serviceAuthVerified,
        });
        return { kind: "ok" as const, row, created };
      });

      if (result.kind === "not_found") {
        throw brainError("raw_artifact_not_found", "no such raw artifact");
      }
      if (result.kind === "tombstoned") {
        throw brainError("raw_artifact_tombstoned", "artifact has been tombstoned", {
          statusOverride: 410,
        });
      }

      // Audit -- section 1 principle 4. extracted may carry PII, so the log
      // body records only identifiers + a content hash of the payload.
      await deps.audit.emit({
        tenantId: writeTenantId,
        layer: "raw",
        actor,
        action: result.created ? "raw.parsed.write" : "raw.parsed.deduplicated",
        inputs: {
          raw_id: id,
          parser: body.parser,
          parser_version: body.parser_version,
          extracted_sha256: sha256Hex(Buffer.from(JSON.stringify(body.extracted))),
        },
        outputs: {
          parsed_id: result.row.id,
          created: result.created,
        },
      });

      reply.status(result.created ? 201 : 200);
      return serializeParsed(result.row);
    },
  );
}
