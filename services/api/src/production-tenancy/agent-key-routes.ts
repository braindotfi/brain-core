import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  AGENT_API_KEY_TTL_DAYS,
  brainError,
  generateAgentApiKey,
  hashAgentApiKey,
  hashBody,
  isAgentApiKeyProfile,
  scopesForAgentApiKeyProfile,
  withTenantScope,
  type AgentApiKeyEnvironment,
  type AgentApiKeyProfile,
  type AuditEmitter,
  type IdempotencyStore,
  type TenantScopedClient,
} from "@brain/shared";
import { BFF_SERVICE_AGENT_DISPLAY_NAME } from "../onboarding/service-token.js";
import { assertPlatformCredential } from "./routes.js";

export interface AgentKeyRoutesDeps {
  readonly pool: Pool;
  readonly resolverPool: Pool;
  readonly audit: AuditEmitter;
  readonly pepper: string;
  readonly environment: AgentApiKeyEnvironment;
  readonly platformSecret?: string;
  readonly idempotencyStore: IdempotencyStore;
  readonly idempotencyTtlSeconds: number;
}

interface AgentRow {
  readonly id: string;
  readonly kind: "internal" | "external";
  readonly display_name: string;
  readonly state: string;
}

interface TenantRow {
  readonly kind: "production" | "demo";
}

interface AgentApiKeyRow {
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

interface IssuedAgentApiKey {
  readonly row: AgentApiKeyRow;
  readonly secret: string;
}

export async function registerAgentApiKeyRoutes(
  app: FastifyInstance,
  deps: AgentKeyRoutesDeps,
): Promise<void> {
  app.post(
    "/tenants/:tenantId/agent-keys",
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (
      request: FastifyRequest<{
        Params: { tenantId: string };
        Body: { agent_id?: unknown; profile?: unknown; name?: unknown; environment?: unknown };
      }>,
      reply,
    ) => {
      const callerTenantId = assertPlatformCredential(
        request,
        deps.platformSecret,
        "tenant:agent-mint",
      );
      assertTenantBinding(callerTenantId, request.params.tenantId);
      const input = parseCreateBody(request.body, deps.environment);
      const idempotency = parseIdempotencyKey(request.headers["idempotency-key"]);
      const bodyHash = hashBody(JSON.stringify(input));
      if (idempotency !== undefined) {
        const probe = await deps.idempotencyStore.probeAndMark({
          tenantId: request.params.tenantId,
          key: idempotency,
          bodyHash,
          ttlSeconds: deps.idempotencyTtlSeconds,
        });
        if (probe.state === "done") {
          reply.header("idempotent-replay", "true").code(probe.response.status);
          return JSON.parse(probe.response.body) as unknown;
        }
        if (probe.state === "in_flight" || probe.state === "conflict") {
          throw brainError(
            "execution_idempotency_conflict",
            probe.state === "in_flight"
              ? "a concurrent request with this Idempotency-Key is still in flight"
              : "Idempotency-Key reused with a different agent key request",
            { statusOverride: 409 },
          );
        }
      }
      try {
        const issued = await withTenantScope(deps.pool, request.params.tenantId, (client) =>
          issueAgentApiKey(client, {
            tenantId: request.params.tenantId,
            agentId: input.agentId,
            profile: input.profile,
            environment: input.environment,
            name: input.name,
            pepper: deps.pepper,
          }),
        );
        await deps.audit.emit({
          tenantId: request.params.tenantId,
          layer: "identity",
          actor: issued.row.agent_id,
          action: "auth.agent_api_key.issued",
          inputs: {
            agent_id: issued.row.agent_id,
            profile: issued.row.profile,
            environment: issued.row.environment,
            name: issued.row.name,
          },
          outputs: { credential_id: issued.row.id, expires_at: issued.row.expires_at },
        });
        const response = serializeAgentApiKey(issued.row, issued.secret);
        if (idempotency !== undefined) {
          await deps.idempotencyStore.complete({
            tenantId: request.params.tenantId,
            key: idempotency,
            bodyHash,
            response: { status: 201, body: JSON.stringify(response) },
            ttlSeconds: deps.idempotencyTtlSeconds,
          });
        }
        reply.code(201);
        return response;
      } catch (error) {
        if (idempotency !== undefined) {
          await deps.idempotencyStore.discard({
            tenantId: request.params.tenantId,
            key: idempotency,
          });
        }
        throw error;
      }
    },
  );

  app.get(
    "/tenants/:tenantId/agent-keys",
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request: FastifyRequest<{ Params: { tenantId: string } }>) => {
      const callerTenantId = assertPlatformCredential(
        request,
        deps.platformSecret,
        "tenant:agent-mint",
      );
      assertTenantBinding(callerTenantId, request.params.tenantId);
      const { rows } = await withTenantScope(deps.pool, request.params.tenantId, (client) =>
        client.query<AgentApiKeyRow>(
          `SELECT id, tenant_id, agent_id, profile, environment, scopes, key_prefix,
                  key_last4, name, created_at, last_used_at, expires_at, revoked_at,
                  rotated_from_id
             FROM agent_api_keys
            WHERE tenant_id = $1
            ORDER BY created_at DESC, id DESC`,
          [request.params.tenantId],
        ),
      );
      return { keys: rows.map((row) => serializeAgentApiKey(row)) };
    },
  );

  app.post(
    "/agent-keys/:id/rotate",
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const callerTenantId = assertPlatformCredential(
        request,
        deps.platformSecret,
        "tenant:agent-mint",
      );
      const tenantId = await resolveAgentKeyTenant(deps.resolverPool, request.params.id);
      if (tenantId === null) {
        throw brainError("api_key_not_found", "agent API key does not exist", {
          statusOverride: 404,
        });
      }
      assertTenantBinding(callerTenantId, tenantId);
      const issued = await withTenantScope(deps.pool, tenantId, async (client) => {
        const { rows } = await client.query<AgentApiKeyRow>(
          `SELECT id, tenant_id, agent_id, profile, environment, scopes, key_prefix,
                  key_last4, name, created_at, last_used_at, expires_at, revoked_at,
                  rotated_from_id
             FROM agent_api_keys
            WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
            FOR UPDATE`,
          [request.params.id],
        );
        const prior = rows[0];
        if (prior === undefined || prior.environment !== deps.environment) {
          throw brainError("api_key_not_found", "agent API key is not active", {
            statusOverride: 404,
          });
        }
        await client.query(`UPDATE agent_api_keys SET revoked_at = now() WHERE id = $1`, [
          prior.id,
        ]);
        return insertAgentApiKey(client, {
          tenantId,
          agentId: prior.agent_id,
          profile: prior.profile,
          environment: prior.environment,
          name: prior.name,
          pepper: deps.pepper,
          rotatedFromId: prior.id,
        });
      });
      await deps.audit.emit({
        tenantId,
        layer: "identity",
        actor: issued.row.agent_id,
        action: "auth.agent_api_key.rotated",
        inputs: { rotated_from_id: request.params.id },
        outputs: { credential_id: issued.row.id, expires_at: issued.row.expires_at },
      });
      reply.code(201);
      return serializeAgentApiKey(issued.row, issued.secret);
    },
  );

  app.delete(
    "/agent-keys/:id",
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const callerTenantId = assertPlatformCredential(
        request,
        deps.platformSecret,
        "tenant:agent-mint",
      );
      const tenantId = await resolveAgentKeyTenant(deps.resolverPool, request.params.id);
      if (tenantId === null) {
        throw brainError("api_key_not_found", "agent API key does not exist", {
          statusOverride: 404,
        });
      }
      assertTenantBinding(callerTenantId, tenantId);
      const { rows } = await withTenantScope(deps.pool, tenantId, (client) =>
        client.query<{ agent_id: string }>(
          `UPDATE agent_api_keys
              SET revoked_at = now()
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING agent_id`,
          [request.params.id],
        ),
      );
      const agentId = rows[0]?.agent_id;
      if (agentId !== undefined) {
        await deps.audit.emit({
          tenantId,
          layer: "identity",
          actor: agentId,
          action: "auth.agent_api_key.revoked",
          inputs: { credential_id: request.params.id },
          outputs: {},
        });
      }
      reply.code(204);
      return null;
    },
  );
}

function assertTenantBinding(callerTenantId: string | undefined, targetTenantId: string): void {
  if (callerTenantId !== undefined && callerTenantId !== targetTenantId) {
    throw brainError("auth_tenant_mismatch", "tenant id does not match authenticated principal", {
      statusOverride: 403,
    });
  }
}

function parseIdempotencyKey(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256) {
    throw brainError("request_params_invalid", "malformed Idempotency-Key header");
  }
  return raw;
}

async function issueAgentApiKey(
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

async function insertAgentApiKey(
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

async function resolveAgentKeyTenant(pool: Pool, id: string): Promise<string | null> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM agent_api_keys WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0]?.tenant_id ?? null;
}

function parseCreateBody(
  body: { agent_id?: unknown; profile?: unknown; name?: unknown; environment?: unknown },
  expectedEnvironment: AgentApiKeyEnvironment,
): {
  agentId: string;
  profile: AgentApiKeyProfile;
  name: string;
  environment: AgentApiKeyEnvironment;
} {
  if (typeof body?.agent_id !== "string" || body.agent_id === "") {
    throw brainError("request_body_invalid", "agent_id is required");
  }
  if (!isAgentApiKeyProfile(body.profile)) {
    throw brainError("request_body_invalid", "profile is not supported");
  }
  if (body.environment !== expectedEnvironment) {
    throw brainError("request_body_invalid", "environment does not match this deployment", {
      details: { expected_environment: expectedEnvironment },
    });
  }
  if (typeof body.name !== "string" || body.name.trim() === "" || body.name.trim().length > 120) {
    throw brainError("request_body_invalid", "name must be between 1 and 120 characters");
  }
  return {
    agentId: body.agent_id,
    profile: body.profile,
    environment: expectedEnvironment,
    name: body.name.trim(),
  };
}

function serializeAgentApiKey(row: AgentApiKeyRow, secret?: string): Record<string, unknown> {
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
