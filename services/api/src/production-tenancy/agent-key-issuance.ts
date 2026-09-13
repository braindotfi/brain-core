import {
  AGENT_API_KEY_TTL_DAYS,
  generateAgentApiKey,
  hashAgentApiKey,
  scopesForAgentApiKeyProfile,
  type AgentApiKeyEnvironment,
  type AgentApiKeyProfile,
  type TenantScopedClient,
} from "@brain/shared";

export interface AgentApiKeyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly profile: AgentApiKeyProfile;
  readonly environment: AgentApiKeyEnvironment;
  readonly scopes: string[];
  readonly key_prefix: string;
  readonly key_last4: string;
  readonly name: string;
  readonly created_at: Date | string;
  readonly last_used_at: Date | string | null;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
  readonly rotated_from_id: string | null;
}

export interface IssuedAgentApiKey {
  readonly row: AgentApiKeyRow;
  readonly secret: string;
}

export async function insertAgentApiKey(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    agentId: string;
    profile: AgentApiKeyProfile;
    environment: AgentApiKeyEnvironment;
    name: string;
    pepper: string;
    rotatedFromId?: string;
  },
): Promise<IssuedAgentApiKey> {
  const generated = generateAgentApiKey(input.environment);
  const scopes = [...scopesForAgentApiKeyProfile(input.profile)];
  const { rows } = await client.query<AgentApiKeyRow>(
    `INSERT INTO agent_api_keys
       (id, tenant_id, agent_id, profile, environment, scopes, hashed_secret,
        key_prefix, key_last4, name, expires_at, rotated_from_id)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10,
             now() + ($11::text || ' days')::interval, $12)
     RETURNING id, tenant_id, agent_id, profile, environment, scopes, key_prefix,
               key_last4, name, created_at, last_used_at, expires_at, revoked_at,
               rotated_from_id`,
    [
      generated.id,
      input.tenantId,
      input.agentId,
      input.profile,
      input.environment,
      scopes,
      hashAgentApiKey(generated.plaintext, input.pepper),
      generated.prefix,
      generated.last4,
      input.name,
      AGENT_API_KEY_TTL_DAYS,
      input.rotatedFromId ?? null,
    ],
  );
  return { row: rows[0]!, secret: generated.plaintext };
}

export function serializeAgentApiKey(
  row: AgentApiKeyRow,
  secret?: string,
): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    profile: row.profile,
    environment: row.environment,
    scopes: row.scopes,
    name: row.name,
    key_prefix: row.key_prefix,
    key_last4: row.key_last4,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    rotated_from_id: row.rotated_from_id,
    ...(secret !== undefined ? { api_key: secret } : {}),
  };
}
