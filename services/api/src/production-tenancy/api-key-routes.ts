import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import {
  API_KEY_PERMITTED_SCOPES,
  brainError,
  newApiKeyId,
  requireScope,
  withTenantScope,
  type AuditEmitter,
  type Principal,
  type Scope,
  type SlidingWindowRateLimiter,
  type TenantScopedClient,
} from "@brain/shared";

export type ApiKeyEnvironment = "sandbox" | "live";

const ENV_PREFIX: Record<ApiKeyEnvironment, string> = {
  sandbox: "brain_sk_test_",
  live: "brain_sk_live_",
};

const DEFAULT_USAGE_WINDOW = "30d";
const MAX_GENERATE_ATTEMPTS = 5;

export interface ApiKeyRoutesDeps {
  pool: Pool;
  resolverPool: Pool;
  audit: AuditEmitter;
  pepper: string;
}

export interface ApiKeyAuthenticatorDeps {
  pool: Pool;
  resolverPool: Pool;
  pepper: string;
  rateLimiter?: SlidingWindowRateLimiter;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  environment: ApiKeyEnvironment;
  scopes: Scope[];
  key_prefix: string;
  key_last4: string;
  hashed_secret: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
  rotated_from_id: string | null;
}

export async function registerApiKeyRoutes(
  app: FastifyInstance,
  deps: ApiKeyRoutesDeps,
): Promise<void> {
  app.post(
    "/tenants/:tenantId/keys",
    async (request: FastifyRequest<{ Params: { tenantId: string } }>, reply) => {
      const principal = requireTenantAdmin(request, request.params.tenantId);
      const body = request.body as
        | { name?: unknown; environment?: unknown; scopes?: unknown }
        | undefined;
      const name = requireName(body?.name);
      const environment = parseEnvironment(body?.environment);
      const scopes = parseIssuedScopes(body?.scopes);

      const issued = await issueKey(deps.pool, {
        tenantId: request.params.tenantId,
        name,
        environment,
        scopes,
        pepper: deps.pepper,
      });

      await deps.audit.emit({
        tenantId: request.params.tenantId,
        layer: "identity",
        actor: principal.id,
        action: "api_key.issued",
        inputs: { name, environment, scopes },
        outputs: { key_id: issued.row.id },
      });

      reply.status(201);
      return serializeKey(issued.row, issued.secret);
    },
  );

  app.get(
    "/tenants/:tenantId/keys",
    async (request: FastifyRequest<{ Params: { tenantId: string } }>) => {
      requireTenantAdmin(request, request.params.tenantId);
      const { rows } = await withTenantScope(deps.pool, request.params.tenantId, (client) =>
        client.query<ApiKeyRow>(
          `SELECT id, tenant_id, name, environment, scopes, key_prefix, key_last4,
                  hashed_secret, created_at, last_used_at, revoked_at, rotated_from_id
             FROM api_keys
            WHERE tenant_id = $1
            ORDER BY created_at DESC, id DESC`,
          [request.params.tenantId],
        ),
      );
      return { keys: rows.map((row) => serializeKey(row)) };
    },
  );

  app.post(
    "/keys/:id/rotate",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const tenantId = await resolveKeyTenant(deps.resolverPool, request.params.id);
      if (tenantId === null) {
        throw brainError("api_key_not_found", "api key does not exist", { statusOverride: 404 });
      }
      const principal = requireTenantAdmin(request, tenantId);

      const issued = await withTenantScope(deps.pool, tenantId, async (client) => {
        const old = await lockActiveKey(client, request.params.id);
        if (old === null) {
          throw brainError("api_key_not_found", "api key is not active", { statusOverride: 404 });
        }
        await client.query(
          `UPDATE api_keys
              SET revoked_at = now()
            WHERE id = $1 AND revoked_at IS NULL`,
          [old.id],
        );
        return insertGeneratedKey(client, {
          tenantId,
          name: old.name,
          environment: old.environment,
          scopes: old.scopes,
          pepper: deps.pepper,
          rotatedFromId: old.id,
        });
      });

      await deps.audit.emit({
        tenantId,
        layer: "identity",
        actor: principal.id,
        action: "api_key.rotated",
        inputs: { rotated_from_id: request.params.id },
        outputs: { key_id: issued.row.id },
      });

      reply.status(201);
      return serializeKey(issued.row, issued.secret);
    },
  );

  app.delete("/keys/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const tenantId = await resolveKeyTenant(deps.resolverPool, request.params.id);
    if (tenantId === null) {
      throw brainError("api_key_not_found", "api key does not exist", { statusOverride: 404 });
    }
    const principal = requireTenantAdmin(request, tenantId);
    const revoked = await withTenantScope(deps.pool, tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE api_keys
              SET revoked_at = now()
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING id`,
        [request.params.id],
      );
      return rows[0] !== undefined;
    });

    if (revoked) {
      await deps.audit.emit({
        tenantId,
        layer: "identity",
        actor: principal.id,
        action: "api_key.revoked",
        inputs: { key_id: request.params.id },
        outputs: { revoked: true },
      });
    }

    reply.status(204);
    return null;
  });

  app.get(
    "/tenants/:tenantId/usage",
    async (
      request: FastifyRequest<{
        Params: { tenantId: string };
        Querystring: { window?: string; environment?: string; key_id?: string };
      }>,
    ) => {
      const principal = requireTenantRead(request, request.params.tenantId);
      requireScope(principal.scopes, "audit:read");
      const window = parseUsageWindow(request.query.window);
      const environment =
        request.query.environment === undefined
          ? undefined
          : parseEnvironment(request.query.environment);
      const keyId = request.query.key_id;
      if (keyId !== undefined && keyId.length === 0) {
        throw brainError("request_params_invalid", "key_id must not be empty");
      }

      const rows = await withTenantScope(deps.pool, request.params.tenantId, (client) =>
        queryUsage(client, {
          tenantId: request.params.tenantId,
          window,
          ...(environment !== undefined ? { environment } : {}),
          ...(keyId !== undefined ? { keyId } : {}),
        }),
      );
      const total = rows.reduce((sum, row) => sum + Number(row.event_count), 0);
      return {
        tenant_id: request.params.tenantId,
        window,
        ...(environment !== undefined ? { environment } : {}),
        ...(keyId !== undefined ? { key_id: keyId } : {}),
        total_events: total,
        keys: rows.map((row) => ({
          key_id: row.key_id,
          environment: row.environment,
          event_count: Number(row.event_count),
          first_event_at: toIso(row.first_event_at),
          last_event_at: toIso(row.last_event_at),
        })),
      };
    },
  );
}

export function buildApiKeyAuthenticator(deps: ApiKeyAuthenticatorDeps) {
  return async (secret: string): Promise<{ principal: Principal; keyId: string } | null> => {
    const hashedSecret = hashApiKeySecret(secret, deps.pepper);
    const { rows } = await deps.resolverPool.query<ApiKeyRow>(
      `SELECT id, tenant_id, name, environment, scopes, key_prefix, key_last4,
              hashed_secret, created_at, last_used_at, revoked_at, rotated_from_id
         FROM api_keys
        WHERE hashed_secret = $1
        LIMIT 1`,
      [hashedSecret],
    );
    const row = rows[0];
    if (row === undefined || row.revoked_at !== null) {
      return null;
    }

    if (deps.rateLimiter !== undefined) {
      const decision = await deps.rateLimiter.hit(`api-key:${row.id}`);
      if (!decision.allowed) {
        throw brainError("rate_limited", "api key rate limit exceeded", {
          details: { key_id: row.id, limit: decision.limit, count: decision.count },
        });
      }
    }

    void withTenantScope(deps.pool, row.tenant_id, (client) =>
      client.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]),
    ).catch(() => undefined);

    return {
      keyId: row.id,
      principal: {
        id: row.id,
        type: "api_partner",
        tenantId: row.tenant_id,
        scopes: row.scopes,
        tokenId: row.id,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    };
  };
}

export function hashApiKeySecret(secret: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}.${secret}`, "utf8").digest("hex");
}

function requireTenantAdmin(request: FastifyRequest, tenantId: string): Principal {
  const principal = requireTenantRead(request, tenantId);
  requireScope(principal.scopes, "execution:admin");
  return principal;
}

function requireTenantRead(request: FastifyRequest, tenantId: string): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  if (principal.tenantId !== tenantId) {
    throw brainError("auth_tenant_mismatch", "tenant id does not match authenticated principal", {
      details: { tenant_id: tenantId, principal_tenant_id: principal.tenantId },
    });
  }
  return principal;
}

function requireName(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw brainError("request_body_invalid", "name must be a non-empty string");
  }
  const name = input.trim();
  if (name.length > 120) {
    throw brainError("request_body_invalid", "name must be 120 characters or fewer");
  }
  return name;
}

function parseEnvironment(input: unknown): ApiKeyEnvironment {
  if (input === "sandbox" || input === "live") return input;
  throw brainError("request_body_invalid", "environment must be sandbox or live");
}

function parseIssuedScopes(input: unknown): Scope[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw brainError("request_body_invalid", "scopes must be a non-empty array of strings");
  }
  const scopes: Scope[] = [];
  for (const value of input) {
    if (typeof value !== "string" || !API_KEY_PERMITTED_SCOPES.has(value as Scope)) {
      throw brainError(
        "request_body_invalid",
        `scope not permitted for an api key: ${String(value)}`,
        {
          details: { scope: value, permitted: [...API_KEY_PERMITTED_SCOPES] },
        },
      );
    }
    if (!scopes.includes(value as Scope)) scopes.push(value as Scope);
  }
  return scopes;
}

function parseUsageWindow(input: unknown): string {
  if (input === undefined) return DEFAULT_USAGE_WINDOW;
  if (typeof input !== "string" || !/^[1-9][0-9]*(d|h)$/.test(input)) {
    throw brainError("request_params_invalid", "window must be an interval like 30d or 24h");
  }
  return input;
}

async function issueKey(
  pool: Pool,
  input: {
    tenantId: string;
    name: string;
    environment: ApiKeyEnvironment;
    scopes: Scope[];
    pepper: string;
  },
): Promise<{ row: ApiKeyRow; secret: string }> {
  return withTenantScope(pool, input.tenantId, async (client) => {
    const tenant = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE id = $1`, [
      input.tenantId,
    ]);
    if (tenant.rows[0] === undefined) {
      throw brainError("tenant_not_found", "tenant does not exist", { statusOverride: 404 });
    }
    return insertGeneratedKey(client, input);
  });
}

async function insertGeneratedKey(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    name: string;
    environment: ApiKeyEnvironment;
    scopes: Scope[];
    pepper: string;
    rotatedFromId?: string;
  },
): Promise<{ row: ApiKeyRow; secret: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt += 1) {
    const secret = `${ENV_PREFIX[input.environment]}${randomBytes(32).toString("base64url")}`;
    const row = {
      id: newApiKeyId(),
      tenantId: input.tenantId,
      name: input.name,
      environment: input.environment,
      scopes: input.scopes,
      keyPrefix: ENV_PREFIX[input.environment],
      keyLast4: secret.slice(-4),
      hashedSecret: hashApiKeySecret(secret, input.pepper),
      rotatedFromId: input.rotatedFromId ?? null,
    };
    try {
      const inserted = await client.query<ApiKeyRow>(
        `INSERT INTO api_keys (
           id, tenant_id, name, environment, scopes, key_prefix, key_last4,
           hashed_secret, rotated_from_id
         )
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)
         RETURNING id, tenant_id, name, environment, scopes, key_prefix, key_last4,
                   hashed_secret, created_at, last_used_at, revoked_at, rotated_from_id`,
        [
          row.id,
          row.tenantId,
          row.name,
          row.environment,
          row.scopes,
          row.keyPrefix,
          row.keyLast4,
          row.hashedSecret,
          row.rotatedFromId,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow === undefined) {
        throw brainError("internal_server_error", "api key insert returned no row");
      }
      return { row: insertedRow, secret };
    } catch (err) {
      if (isUniqueViolation(err)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw brainError("internal_server_error", "could not generate a unique api key", {
    details: { cause: String(lastError) },
  });
}

async function lockActiveKey(client: TenantScopedClient, id: string): Promise<ApiKeyRow | null> {
  const { rows } = await client.query<ApiKeyRow>(
    `SELECT id, tenant_id, name, environment, scopes, key_prefix, key_last4,
            hashed_secret, created_at, last_used_at, revoked_at, rotated_from_id
       FROM api_keys
      WHERE id = $1 AND revoked_at IS NULL
      FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

async function resolveKeyTenant(pool: Pool, id: string): Promise<string | null> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM api_keys WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0]?.tenant_id ?? null;
}

interface UsageRow {
  key_id: string;
  environment: ApiKeyEnvironment | null;
  event_count: string | number;
  first_event_at: Date | string | null;
  last_event_at: Date | string | null;
}

async function queryUsage(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    window: string;
    environment?: ApiKeyEnvironment;
    keyId?: string;
  },
): Promise<UsageRow[]> {
  const params: unknown[] = [input.tenantId, intervalForWindow(input.window)];
  const filters = [
    "e.tenant_id = $1",
    "e.created_at >= now() - $2::interval",
    "e.key_id IS NOT NULL",
  ];
  if (input.environment !== undefined) {
    params.push(input.environment);
    filters.push(`k.environment = $${params.length}`);
  }
  if (input.keyId !== undefined) {
    params.push(input.keyId);
    filters.push(`e.key_id = $${params.length}`);
  }
  const { rows } = await client.query<UsageRow>(
    `SELECT e.key_id,
            k.environment,
            count(*) AS event_count,
            min(e.created_at) AS first_event_at,
            max(e.created_at) AS last_event_at
       FROM audit_events e
       LEFT JOIN api_keys k ON k.id = e.key_id AND k.tenant_id = e.tenant_id
      WHERE ${filters.join(" AND ")}
      GROUP BY e.key_id, k.environment
      ORDER BY event_count DESC, e.key_id ASC`,
    params,
  );
  return rows;
}

function intervalForWindow(window: string): string {
  const amount = Number(window.slice(0, -1));
  return window.endsWith("d") ? `${amount} days` : `${amount} hours`;
}

function serializeKey(row: ApiKeyRow, secret?: string) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    environment: row.environment,
    scopes: row.scopes,
    key_prefix: row.key_prefix,
    key_last4: row.key_last4,
    masked_key: `${row.key_prefix}...${row.key_last4}`,
    created_at: toIso(row.created_at),
    last_used_at: toIso(row.last_used_at),
    revoked_at: toIso(row.revoked_at),
    rotated_from_id: row.rotated_from_id,
    ...(secret !== undefined ? { secret } : {}),
  };
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}
