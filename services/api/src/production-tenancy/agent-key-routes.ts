import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  brainError,
  hashBody,
  isAgentApiKeyProfile,
  withTenantScope,
  type AgentApiKeyEnvironment,
  type AgentApiKeyProfile,
  type AuditEmitter,
  type IdempotencyStore,
} from "@brain/shared";
import { insertAgentApiKey, issueAgentApiKey, type AgentApiKeyRow } from "./agent-key-store.js";
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
