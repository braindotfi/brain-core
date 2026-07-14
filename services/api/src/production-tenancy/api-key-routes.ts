/**
 * Per-customer API-key authentication (token-exchange model).
 *
 * A customer holding an issued key exchanges it for a short-lived agent JWT:
 *
 *   POST /v1/auth/api-key           header X-Api-Key: brain_sk_...  -> Bearer JWT
 *
 * Keys are ISSUED and REVOKED only by an operator holding the platform
 * credential (the same fence as POST /v1/tenants), never self-minted:
 *
 *   POST   /v1/tenants/:tenantId/api-keys
 *   DELETE /v1/tenants/:tenantId/api-keys/:keyId
 *
 * Storage mirrors session_refresh_tokens: only the sha256 hash of the secret
 * is stored (api_keys.token_hash), and the cross-tenant hash lookup on
 * exchange goes through the resolver pool (brain_resolver, BYPASSRLS + a
 * narrow per-table SELECT grant), exactly like findRefreshToken above.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  API_KEY_PERMITTED_SCOPES,
  brainError,
  computeAgentScopeHash,
  newAgentId,
  newApiKeyId,
  newTokenId,
  withTenantScope,
  type AuditEmitter,
  type JwtSigner,
  type Scope,
} from "@brain/shared";
import { assertPlatformCredential, hashToken, newSecretToken } from "./routes.js";

const API_KEY_PREFIX = "brain_sk_";
const EXCHANGE_TTL_SECONDS = 60 * 60; // 1 hour, matches service-token.

export interface ApiKeyRoutesDeps {
  pool: Pool;
  /** Cross-tenant hash lookup on exchange, same role as session refresh tokens. */
  resolverPool: Pool;
  audit: AuditEmitter;
  signer: JwtSigner;
  platformSecret?: string;
}

interface ApiKeyRow {
  token_hash: string;
  key_id: string;
  tenant_id: string;
  agent_id: string;
  scopes: Scope[];
  revoked_at: Date | string | null;
  expires_at: Date | string | null;
}

export async function registerApiKeyRoutes(
  app: FastifyInstance,
  deps: ApiKeyRoutesDeps,
): Promise<void> {
  // ---- Exchange: POST /auth/api-key --------------------------------------
  app.post(
    "/auth/api-key",
    { config: { skipAuth: true, rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const headerRaw = request.headers["x-api-key"];
      const provided = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
      if (provided === undefined || provided.length === 0) {
        return exchangeUnauthorized(reply, request.id);
      }

      const tokenHash = hashToken(provided);
      const { rows } = await deps.resolverPool.query<ApiKeyRow>(
        `SELECT token_hash, key_id, tenant_id, agent_id, scopes, revoked_at, expires_at
           FROM api_keys WHERE token_hash = $1 LIMIT 1`,
        [tokenHash],
      );
      const row = rows[0];
      // Not found, revoked, or expired all fall through to the same generic
      // 401 below — never leak which condition failed.
      if (row === undefined || row.revoked_at !== null || isPast(row.expires_at)) {
        return exchangeUnauthorized(reply, request.id);
      }

      await withTenantScope(deps.pool, row.tenant_id, (client) =>
        client.query(`UPDATE api_keys SET last_used_at = now() WHERE token_hash = $1`, [tokenHash]),
      );

      const tokenId = newTokenId();
      const token = await deps.signer.sign({
        id: row.agent_id,
        type: "agent",
        tenantId: row.tenant_id,
        tokenId,
        expiresAt: Math.floor(Date.now() / 1000) + EXCHANGE_TTL_SECONDS,
        scopes: row.scopes,
      });

      await deps.audit.emit({
        tenantId: row.tenant_id,
        layer: "agent",
        actor: row.agent_id,
        action: "auth.api_key.exchanged",
        inputs: { key_id: row.key_id },
        outputs: { tenant_id: row.tenant_id, key_id: row.key_id, token_id: tokenId },
      });

      reply.status(200);
      return {
        token,
        token_type: "Bearer",
        expires_in: EXCHANGE_TTL_SECONDS,
        tenant_id: row.tenant_id,
        agent_id: row.agent_id,
        scopes: row.scopes,
      };
    },
  );

  // ---- Issue: POST /tenants/:tenantId/api-keys ----------------------------
  app.post(
    "/tenants/:tenantId/api-keys",
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // Same platform fence as POST /v1/tenants; "tenant:create" is the
      // closest existing literal in the fixed assertPlatformCredential union
      // (deliberately not widened with a new colon-separated literal, which
      // check-scope-vocab would flag as a candidate Brain scope).
      assertPlatformCredential(request, deps.platformSecret, "tenant:create");
      const { tenantId } = request.params as { tenantId: string };
      const body = request.body as
        | { name?: unknown; scopes?: unknown; expires_at?: unknown }
        | undefined;
      const scopes = parseIssuedScopes(body?.scopes);
      const expiresAt = parseExpiresAt(body?.expires_at);
      const name =
        typeof body?.name === "string" && body.name.trim().length > 0 ? body.name.trim() : null;

      const scopeHash = Buffer.from(computeAgentScopeHash(scopes).slice(2), "hex");
      const plaintext = API_KEY_PREFIX + newSecretToken();
      const tokenHash = hashToken(plaintext);
      const keyId = newApiKeyId();
      const agentId = newAgentId();

      await withTenantScope(deps.pool, tenantId, async (client) => {
        const { rows: tenantRows } = await client.query<{ id: string }>(
          `SELECT id FROM tenants WHERE id = $1 LIMIT 1`,
          [tenantId],
        );
        if (tenantRows[0] === undefined) {
          throw brainError("tenant_not_found", "tenant does not exist", { statusOverride: 404 });
        }
        // kind='external' + role='partner': this agent represents a
        // customer-held credential, not an internal Brain-owned agent (that
        // distinction is what service-token's kind='internal' role='payment'
        // insert encodes). state='active' immediately -- there is no
        // on-chain registration step for an API-key agent.
        await client.query(
          `INSERT INTO agents (id, tenant_id, kind, role, display_name, scope_hash, state, registered_at, created_at)
           VALUES ($1, $2, 'external', 'partner', $3, $4, 'active', now(), now())`,
          [agentId, tenantId, name ?? "API key", scopeHash],
        );
        await client.query(
          `INSERT INTO api_keys (token_hash, key_id, tenant_id, agent_id, scopes, name, expires_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
          [tokenHash, keyId, tenantId, agentId, JSON.stringify(scopes), name, expiresAt],
        );
      });

      await deps.audit.emit({
        tenantId,
        layer: "agent",
        actor: agentId,
        action: "auth.api_key.issued",
        inputs: { name, scopes },
        outputs: { key_id: keyId, agent_id: agentId },
      });

      reply.status(201);
      // The plaintext key is returned exactly once, right here. Only its
      // sha256 hash is persisted (api_keys.token_hash) -- it cannot be
      // retrieved again after this response; a lost key must be reissued.
      return {
        api_key: plaintext,
        key_id: keyId,
        agent_id: agentId,
        tenant_id: tenantId,
        scopes,
        name,
        expires_at: expiresAt,
      };
    },
  );

  // ---- Revoke: DELETE /tenants/:tenantId/api-keys/:keyId ------------------
  app.delete(
    "/tenants/:tenantId/api-keys/:keyId",
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      assertPlatformCredential(request, deps.platformSecret, "tenant:create");
      const { tenantId, keyId } = request.params as { tenantId: string; keyId: string };

      // Three-way outcome so a typo'd key id 404s (route is platform-secret
      // gated -- the caller is trusted, so revealing existence leaks nothing)
      // while re-revoking an already-revoked key stays a silent no-op (no
      // repeat audit event, no repeat agent update).
      const outcome = await withTenantScope(deps.pool, tenantId, async (client) => {
        const { rows } = await client.query<{ agent_id: string }>(
          `UPDATE api_keys SET revoked_at = now()
             WHERE tenant_id = $1 AND key_id = $2 AND revoked_at IS NULL
           RETURNING agent_id`,
          [tenantId, keyId],
        );
        const row = rows[0];
        if (row !== undefined) {
          await client.query(
            `UPDATE agents SET state = 'revoked' WHERE tenant_id = $1 AND id = $2`,
            [tenantId, row.agent_id],
          );
          return { status: "revoked" as const, agentId: row.agent_id };
        }
        // No row updated -- either already revoked or never existed.
        // Disambiguate with a plain existence check.
        const { rows: existing } = await client.query<{ found: number }>(
          `SELECT 1 AS found FROM api_keys WHERE tenant_id = $1 AND key_id = $2 LIMIT 1`,
          [tenantId, keyId],
        );
        return existing[0] === undefined
          ? { status: "not_found" as const }
          : { status: "already_revoked" as const };
      });

      if (outcome.status === "not_found") {
        throw brainError("api_key_not_found", "api key does not exist", { statusOverride: 404 });
      }

      if (outcome.status === "revoked") {
        await deps.audit.emit({
          tenantId,
          layer: "agent",
          actor: outcome.agentId,
          action: "auth.api_key.revoked",
          inputs: {},
          outputs: { key_id: keyId, agent_id: outcome.agentId },
        });
      }

      reply.status(204);
      return null;
    },
  );
}

/** Generic 401, deliberately identical for not-found / revoked / expired. */
function exchangeUnauthorized(
  reply: { status: (code: number) => void },
  requestId: string,
): { error: Record<string, unknown> } {
  reply.status(401);
  return {
    error: {
      code: "auth_header_invalid",
      message: "X-Api-Key header missing or does not match an active api key",
      request_id: requestId,
      docs_url: "https://docs.brain.fi/api-reference/authentication",
    },
  };
}

// Default (no `scopes` in the issuance body) grants a read+propose+audit set --
// ledger:read, wiki:read, raw:read, policy:read, execution:read, audit:read,
// execution:propose, payment_intent:propose. A proper subset of
// API_KEY_PERMITTED_SCOPES (verified below); `raw:write` (document ingestion)
// is opt-in only via explicit scopes, not granted by default.
const DEFAULT_ISSUED_SCOPES: readonly Scope[] = [
  "ledger:read",
  "wiki:read",
  "raw:read",
  "policy:read",
  "execution:read",
  "audit:read",
  "execution:propose",
  "payment_intent:propose",
];

function parseIssuedScopes(input: unknown): Scope[] {
  const candidate = input === undefined ? DEFAULT_ISSUED_SCOPES : input;
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw brainError("request_body_invalid", "scopes must be a non-empty array of strings");
  }
  // Same allowlist check for the default and the explicit path -- defense in
  // depth so the default can never silently drift past the api-key cap.
  for (const s of candidate) {
    if (typeof s !== "string" || !API_KEY_PERMITTED_SCOPES.has(s as Scope)) {
      throw brainError("request_body_invalid", `scope not permitted for an api key: ${String(s)}`, {
        details: { scope: s },
      });
    }
  }
  return candidate as Scope[];
}

function parseExpiresAt(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") {
    throw brainError("request_body_invalid", "expires_at must be an ISO 8601 string");
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw brainError("request_body_invalid", "expires_at must be a valid ISO 8601 timestamp");
  }
  return parsed.toISOString();
}

function isPast(value: Date | string | null): boolean {
  if (value === null) return false; // NULL expires_at = no expiry.
  return new Date(value).getTime() <= Date.now();
}
