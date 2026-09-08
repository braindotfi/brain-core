import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  ACCESS_TOKEN_REQUESTED_TYPE,
  AGENT_ACCESS_TOKEN_TTL_SECONDS,
  AGENT_API_KEY_SUBJECT_TOKEN_TYPE,
  agentApiKeyHashesEqual,
  hashAgentApiKey,
  isAgentApiKeyProfile,
  newTokenId,
  parseAgentApiKey,
  scopesForAgentApiKeyProfile,
  scopesMatchAgentApiKeyProfile,
  withTenantScope,
  type AgentApiKeyEnvironment,
  type AgentApiKeyProfile,
  type AuditEmitter,
  type JwtSigner,
  type Scope,
  type TenantScopedClient,
} from "@brain/shared";

export interface AgentKeyExchangeDeps {
  readonly authPool: Pool;
  readonly resolverPool: Pool;
  readonly audit: AuditEmitter;
  readonly signer: JwtSigner;
  readonly pepper: string;
  readonly environment: AgentApiKeyEnvironment;
  readonly resource: string;
}

interface AgentKeyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly profile: string;
  readonly environment: string;
  readonly scopes: string[];
  readonly hashed_secret: string;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
  readonly agent_state: string;
  readonly agent_kind: string;
}

export interface AgentKeyExchangeBody {
  readonly grant_type?: unknown;
  readonly subject_token?: unknown;
  readonly subject_token_type?: unknown;
  readonly requested_token_type?: unknown;
  readonly resource?: unknown;
  readonly audience?: unknown;
  readonly scope?: unknown;
}

type ExchangeError = "invalid_request" | "invalid_scope" | "invalid_target";

function reject(reply: FastifyReply, error: ExchangeError): { error: ExchangeError } {
  reply.code(400);
  return { error };
}

function oneString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requestedScopes(value: unknown, allowed: readonly Scope[]): readonly Scope[] | null {
  if (value === undefined || value === "") return allowed;
  if (typeof value !== "string") return null;
  const requested = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  const allowedSet = new Set<string>(allowed);
  if (requested.length === 0 || requested.some((scope) => !allowedSet.has(scope))) return null;
  return requested as Scope[];
}

async function resolveTenantId(pool: Pool, credentialId: string): Promise<string | null> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM agent_api_keys WHERE id = $1 LIMIT 1`,
    [credentialId],
  );
  return rows[0]?.tenant_id ?? null;
}

async function authenticateAndTouchKey(
  pool: Pool,
  tenantId: string,
  credentialId: string,
  environment: AgentApiKeyEnvironment,
  computedHash: string,
): Promise<AgentKeyRow | null> {
  return withTenantScope(pool, tenantId, async (client: TenantScopedClient) => {
    const { rows } = await client.query<AgentKeyRow>(
      `SELECT k.id, k.tenant_id, k.agent_id, k.profile, k.environment, k.scopes,
              k.hashed_secret, k.expires_at, k.revoked_at,
              a.state AS agent_state, a.kind AS agent_kind
         FROM agent_api_keys k
         JOIN agents a ON a.tenant_id = k.tenant_id AND a.id = k.agent_id
        WHERE k.tenant_id = $1 AND k.id = $2
        LIMIT 1
        FOR UPDATE OF k`,
      [tenantId, credentialId],
    );
    const row = rows[0];
    if (
      row === undefined ||
      row.revoked_at !== null ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      row.environment !== environment ||
      row.agent_state !== "active" ||
      row.agent_kind !== "internal" ||
      !isAgentApiKeyProfile(row.profile) ||
      !scopesMatchAgentApiKeyProfile(row.profile, row.scopes) ||
      !agentApiKeyHashesEqual(row.hashed_secret, computedHash)
    ) {
      return null;
    }
    await client.query(`UPDATE agent_api_keys SET last_used_at = now() WHERE id = $1`, [row.id]);
    return row;
  });
}

/** RFC 8693 exchange for one server-managed, profile-bound agent key. */
export async function handleAgentKeyExchange(
  deps: AgentKeyExchangeDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  body: AgentKeyExchangeBody,
): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") {
    return reject(reply, "invalid_request");
  }
  const subjectToken = oneString(body.subject_token);
  if (
    subjectToken === undefined ||
    oneString(body.subject_token_type) !== AGENT_API_KEY_SUBJECT_TOKEN_TYPE ||
    (body.requested_token_type !== undefined &&
      oneString(body.requested_token_type) !== ACCESS_TOKEN_REQUESTED_TYPE)
  ) {
    return reject(reply, "invalid_request");
  }
  if (oneString(body.resource) !== deps.resource || body.audience !== undefined) {
    return reject(reply, "invalid_target");
  }

  const parsed = parseAgentApiKey(subjectToken);
  const computedHash = hashAgentApiKey(subjectToken, deps.pepper);
  if (parsed === null || parsed.environment !== deps.environment) {
    request.log.warn({ event: "oauth.agent_key_exchange.failed", reason: "invalid_credential" });
    return reject(reply, "invalid_request");
  }

  const tenantId = await resolveTenantId(deps.resolverPool, parsed.id);
  if (tenantId === null) {
    request.log.warn({
      event: "oauth.agent_key_exchange.failed",
      reason: "unknown_credential",
      credentialId: parsed.id,
    });
    return reject(reply, "invalid_request");
  }
  const row = await authenticateAndTouchKey(
    deps.authPool,
    tenantId,
    parsed.id,
    deps.environment,
    computedHash,
  );
  if (row === null) {
    request.log.warn({
      event: "oauth.agent_key_exchange.failed",
      reason: "credential_not_eligible",
      credentialId: parsed.id,
    });
    return reject(reply, "invalid_request");
  }

  const profile = row.profile as AgentApiKeyProfile;
  const scopes = requestedScopes(body.scope, scopesForAgentApiKeyProfile(profile));
  if (scopes === null) return reject(reply, "invalid_scope");

  const tokenId = newTokenId();
  const accessToken = await deps.signer.sign(
    {
      id: row.agent_id,
      type: "agent",
      tenantId: row.tenant_id,
      scopes,
      tokenId,
      credentialId: row.id,
      expiresAt: Math.floor(Date.now() / 1000) + AGENT_ACCESS_TOKEN_TTL_SECONDS,
    },
    deps.resource,
  );
  await deps.audit.emit({
    tenantId: row.tenant_id,
    layer: "identity",
    actor: row.agent_id,
    action: "oauth.agent_api_key.exchanged",
    inputs: { credential_id: row.id, profile },
    outputs: { token_id: tokenId, scopes, audience: deps.resource },
  });

  reply.code(200);
  return {
    access_token: accessToken,
    issued_token_type: ACCESS_TOKEN_REQUESTED_TYPE,
    token_type: "Bearer",
    expires_in: AGENT_ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
  };
}
