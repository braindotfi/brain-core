import {
  AGENT_API_KEY_TTL_DAYS,
  brainError,
  generateAgentApiKey,
  hashAgentApiKey,
  scopesForAgentApiKeyProfile,
  type AgentApiKeyEnvironment,
  type AgentApiKeyProfile,
  type Scope,
  type TenantScopedClient,
} from "@brain/shared";
import { BFF_SERVICE_AGENT_DISPLAY_NAME } from "../onboarding/service-token.js";

interface AgentRow {
  readonly id: string;
  readonly kind: "internal" | "external";
  readonly display_name: string;
  readonly state: string;
}

interface TenantRow {
  readonly kind: "production" | "demo";
}

export interface AgentApiKeyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly profile: AgentApiKeyProfile;
  readonly environment: AgentApiKeyEnvironment;
  readonly scopes: Scope[];
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

export async function issueAgentApiKey(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    agentId: string;
    profile: AgentApiKeyProfile;
    environment: AgentApiKeyEnvironment;
    name: string;
    pepper: string;
  },
): Promise<IssuedAgentApiKey> {
  const { rows: tenantRows } = await client.query<TenantRow>(
    `SELECT kind FROM tenants WHERE id = $1 LIMIT 1`,
    [input.tenantId],
  );
  const tenant = tenantRows[0];
  if (tenant === undefined) {
    throw brainError("tenant_not_found", "tenant does not exist", { statusOverride: 404 });
  }
  const { rows: agentRows } = await client.query<AgentRow>(
    `SELECT id, kind, display_name, state
       FROM agents
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1`,
    [input.tenantId, input.agentId],
  );
  const agent = agentRows[0];
  if (agent === undefined || agent.state !== "active" || agent.kind !== "internal") {
    throw brainError("execution_agent_not_registered", "active internal agent required", {
      statusOverride: 403,
      details: { agent_id: input.agentId },
    });
  }
  if (
    input.profile === "bff_service_v1" &&
    (tenant.kind !== "production" || agent.display_name !== BFF_SERVICE_AGENT_DISPLAY_NAME)
  ) {
    throw brainError("auth_scope_insufficient", "BFF profile requires the production BFF agent", {
      statusOverride: 403,
      details: { agent_id: input.agentId, profile: input.profile },
    });
  }
  return insertAgentApiKey(client, input);
}

export async function findActiveAgentApiKeyByName(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    agentId: string;
    profile: AgentApiKeyProfile;
    environment: AgentApiKeyEnvironment;
    name: string;
  },
): Promise<AgentApiKeyRow | null> {
  const { rows } = await client.query<AgentApiKeyRow>(
    `SELECT id, tenant_id, agent_id, profile, environment, scopes, key_prefix,
            key_last4, name, created_at, last_used_at, expires_at, revoked_at,
            rotated_from_id
       FROM agent_api_keys
      WHERE tenant_id = $1 AND agent_id = $2 AND profile = $3
        AND environment = $4 AND name = $5
        AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE`,
    [input.tenantId, input.agentId, input.profile, input.environment, input.name],
  );
  return rows[0] ?? null;
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
