import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import {
  API_KEY_PERMITTED_SCOPES,
  API_KEY_SYNTHETIC_DEMO_PERMITTED_SCOPES,
  brainError,
  newApiKeyId,
  requireAdminMember,
  requireScope,
  withTenantScope,
  type AuditEmitter,
  type ApiKeyAuthenticationResult,
  type Principal,
  type ApiRateLimitDecision,
  type ApiRateLimitPolicy,
  type ApiSlidingWindowRateLimiter,
  type Scope,
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
  rateLimiter: ApiSlidingWindowRateLimiter;
  /**
   * Minimum time between `last_used_at` DB writes for the same key (Review P3).
   * A busy key would otherwise fire one unawaited UPDATE per request; this
   * coalesces bursts into at most one write per window. Default 60s. This is
   * a display timestamp only, a per-process, in-memory cooldown is fine even
   * though the API runs as multiple replicas (worst case: one write per
   * replica per window, still a hard, predictable ceiling instead of one per
   * request). Set to 0 to disable (e.g. in tests that assert every write).
   */
  lastUsedAtCooldownMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_LAST_USED_AT_COOLDOWN_MS = 60_000;

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
  expires_at: Date | string | null;
  rotated_from_id: string | null;
  provisioning_state?: TenantApiKeyState["provisioning_state"];
  data_profile?: TenantApiKeyState["data_profile"];
  access_stage?: TenantApiKeyState["access_stage"];
  tier_id?: string | null;
  tier_display_name?: string | null;
  entitlement_version?: number | null;
  entitlement_status?: "active" | "suspended" | null;
  rate_window_seconds?: number | null;
  tier_key_limit?: number | null;
  tenant_limit?: number | null;
  override_key_limit?: number | null;
  override_expires_at?: Date | string | null;
}

interface TenantApiKeyState {
  provisioning_state: "provisioning" | "ready_demo" | "seed_failed" | "archived" | null;
  data_profile: "synthetic_brightline_v1" | "customer" | null;
  access_stage: "demo" | "production_review" | "production" | null;
}

export async function registerApiKeyRoutes(
  app: FastifyInstance,
  deps: ApiKeyRoutesDeps,
): Promise<void> {
  app.post(
    "/tenants/:tenantId/keys",
    async (request: FastifyRequest<{ Params: { tenantId: string } }>, reply) => {
      const principal = await requireTenantAdmin(request, deps.pool, request.params.tenantId);
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
      await requireTenantAdmin(request, deps.pool, request.params.tenantId);
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
      const principal = await requireTenantAdmin(request, deps.pool, tenantId);

      const issued = await withTenantScope(deps.pool, tenantId, async (client) => {
        const old = await lockActiveKey(client, request.params.id);
        if (old === null) {
          throw brainError("api_key_not_found", "api key is not active", { statusOverride: 404 });
        }
        if (hasDemoRawScope(old.scopes)) {
          const tenant = await loadTenantApiKeyState(client, tenantId);
          if (tenant === null) {
            throw brainError("tenant_not_found", "tenant does not exist", { statusOverride: 404 });
          }
          assertScopesAllowedForTenant(old.environment, old.scopes, tenant);
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
    const principal = await requireTenantAdmin(request, deps.pool, tenantId);
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

      const bounds = usageBounds(window, new Date());
      const [rows, entitlement, completeness] = await withTenantScope(
        deps.pool,
        request.params.tenantId,
        async (client) => {
          const usageRows = await queryUsage(client, {
            tenantId: request.params.tenantId,
            periodStart: bounds.periodStart,
            periodEnd: bounds.periodEnd,
            ...(environment !== undefined ? { environment } : {}),
            ...(keyId !== undefined ? { keyId } : {}),
          });
          const effectiveEntitlement =
            environment === undefined
              ? null
              : await loadUsageEntitlement(client, {
                  tenantId: request.params.tenantId,
                  environment,
                  ...(keyId !== undefined ? { keyId } : {}),
                });
          const usageCompleteness = await loadUsageCompleteness(client, {
            tenantId: request.params.tenantId,
            periodStart: bounds.periodStart,
            periodEnd: bounds.periodEnd,
            ...(environment !== undefined ? { environment } : {}),
          });
          return [usageRows, effectiveEntitlement, usageCompleteness] as const;
        },
      );
      const total = rows.reduce((sum, row) => sum + Number(row.request_count), 0);
      const billableUnits = rows.reduce((sum, row) => sum + Number(row.billable_units), 0);
      const rejectedRequests = rows
        .filter((row) => row.outcome !== "success")
        .reduce((sum, row) => sum + Number(row.request_count), 0);
      return {
        tenant_id: request.params.tenantId,
        window,
        period_start: bounds.periodStart.toISOString(),
        period_end: bounds.periodEnd.toISOString(),
        ...(environment !== undefined ? { environment } : {}),
        ...(keyId !== undefined ? { key_id: keyId } : {}),
        entitlement,
        total_requests: total,
        authenticated_requests: total,
        rejected_requests: rejectedRequests,
        billable_units: billableUnits,
        source: completeness.closed ? "closed_period" : "raw_meter",
        completeness: {
          status: completeness.status,
          last_reconciled_at: completeness.lastReconciledAt,
          meter_persistence_failures: completeness.meterPersistenceFailures,
        },
        breakdowns: summarizeUsage(rows),
        // Compatibility alias for BrainMVB until its Phase 3 usage view moves
        // to the expanded request-meter contract.
        total_events: total,
        keys: summarizeKeys(rows),
      };
    },
  );
}

export function buildApiKeyAuthenticator(deps: ApiKeyAuthenticatorDeps) {
  const cooldownMs = deps.lastUsedAtCooldownMs ?? DEFAULT_LAST_USED_AT_COOLDOWN_MS;
  const now = deps.now ?? (() => Date.now());
  // Per-authenticator-instance (i.e. per process), not shared across replicas.
  // See the ApiKeyAuthenticatorDeps.lastUsedAtCooldownMs doc comment for why
  // that's an acceptable tradeoff for this field.
  const lastWrittenAt = new Map<string, number>();

  return async (
    secret: string,
    requestContext?: { requestId: string },
  ): Promise<ApiKeyAuthenticationResult> => {
    const lookup = parseApiKeyLookup(secret);
    if (lookup === null) {
      return { kind: "unknown_rejected", reason: "malformed" };
    }
    const hashedSecret = hashApiKeySecret(secret, deps.pepper);
    const { rows } = await deps.resolverPool.query<ApiKeyRow>(
      `SELECT k.id, k.tenant_id, k.name, k.environment, k.scopes, k.key_prefix, k.key_last4,
              k.hashed_secret, k.created_at, k.last_used_at, k.revoked_at, k.expires_at,
              k.rotated_from_id, t.provisioning_state, t.data_profile, t.access_stage,
              ent.tier_id, tier.display_name AS tier_display_name,
              ent.version AS entitlement_version, ent.status AS entitlement_status,
              tier.window_seconds AS rate_window_seconds,
              tier.key_limit AS tier_key_limit, tier.tenant_limit,
              override.key_limit AS override_key_limit,
              override.expires_at AS override_expires_at
         FROM api_keys k
         JOIN tenants t ON t.id = k.tenant_id
         LEFT JOIN tenant_api_entitlements ent
           ON ent.tenant_id = k.tenant_id AND ent.environment = k.environment
         LEFT JOIN api_rate_limit_tiers tier ON tier.id = ent.tier_id
         LEFT JOIN api_key_rate_limit_overrides override
           ON override.key_id = k.id AND override.tenant_id = k.tenant_id
        WHERE k.key_prefix = $1 AND k.key_last4 = $2
        ORDER BY k.created_at DESC, k.id DESC`,
      [lookup.keyPrefix, lookup.keyLast4],
    );
    const row = rows.find((candidate) => hashesEqual(candidate.hashed_secret, hashedSecret));
    const nowMs = now();
    if (row === undefined) {
      return { kind: "unknown_rejected", reason: "unknown" };
    }
    const attribution = {
      keyId: row.id,
      tenantId: row.tenant_id,
      environment: row.environment,
      accessStage: row.access_stage ?? null,
    };
    if (row.revoked_at !== null) {
      return { kind: "known_rejected", attribution, reason: "revoked" };
    }
    if (row.expires_at !== null && Date.parse(String(row.expires_at)) <= nowMs) {
      return { kind: "known_rejected", attribution, reason: "expired" };
    }
    if (hasDemoRawScope(row.scopes) && !isVerifiedSyntheticDemoKey(row)) {
      return { kind: "known_rejected", attribution, reason: "tenant_ineligible" };
    }
    if (row.entitlement_status === "suspended") {
      return { kind: "known_rejected", attribution, reason: "tenant_ineligible" };
    }

    const policy = resolveApiRateLimitPolicy(row, nowMs);
    if (policy === null) {
      return { kind: "known_rejected", attribution, reason: "rate_limiter_unavailable" };
    }
    let rateLimit: ApiRateLimitDecision;
    try {
      rateLimit = await deps.rateLimiter.hit({
        keyBucket: `api-rate:key:${row.id}`,
        tenantBucket: `api-rate:tenant:${row.tenant_id}:${row.environment}`,
        requestId: requestContext?.requestId ?? randomUUID(),
        policy,
      });
    } catch {
      return {
        kind: "known_rejected",
        attribution,
        reason: "rate_limiter_unavailable",
        rateLimitPolicy: policy,
      };
    }
    if (!rateLimit.allowed) {
      return {
        kind: "known_rejected",
        attribution,
        reason: "rate_limited",
        rateLimit,
      };
    }

    // Ceiling on the never-evicted cooldown map (revoked/rotated keys never get
    // removed). Clearing on overflow is safe: worst case is one extra
    // last_used_at write per key afterward, and the field is display-only.
    if (lastWrittenAt.size > 50_000) {
      lastWrittenAt.clear();
    }
    const lastWrite = lastWrittenAt.get(row.id);
    if (lastWrite === undefined || nowMs - lastWrite >= cooldownMs) {
      // Set before firing the write (not after it resolves) so a burst of
      // requests arriving before this async write settles doesn't each pass
      // the cooldown check and pile up duplicate writes for the same key.
      lastWrittenAt.set(row.id, nowMs);
      void withTenantScope(deps.pool, row.tenant_id, (client) =>
        client.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]),
      ).catch(() => undefined);
    }

    return {
      kind: "authenticated",
      keyId: row.id,
      attribution,
      rateLimit,
      rateLimitPolicy: rateLimit.policy,
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

function resolveApiRateLimitPolicy(row: ApiKeyRow, nowMs: number): ApiRateLimitPolicy | null {
  if (
    row.entitlement_status !== "active" ||
    row.tier_id === null ||
    row.tier_id === undefined ||
    row.entitlement_version === null ||
    row.entitlement_version === undefined ||
    row.rate_window_seconds === null ||
    row.rate_window_seconds === undefined ||
    row.tier_key_limit === null ||
    row.tier_key_limit === undefined ||
    row.tenant_limit === null ||
    row.tenant_limit === undefined
  ) {
    return null;
  }
  const overrideActive =
    row.override_key_limit !== null &&
    row.override_key_limit !== undefined &&
    (row.override_expires_at === null ||
      row.override_expires_at === undefined ||
      Date.parse(String(row.override_expires_at)) > nowMs);
  return {
    tierId: row.tier_id,
    entitlementVersion: row.entitlement_version,
    windowSeconds: row.rate_window_seconds,
    keyLimit: overrideActive
      ? Math.min(row.tier_key_limit, row.override_key_limit!)
      : row.tier_key_limit,
    tenantLimit: row.tenant_limit,
  };
}

export function hashApiKeySecret(secret: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}.${secret}`, "utf8").digest("hex");
}

function parseApiKeyLookup(
  secret: string,
): { keyPrefix: (typeof ENV_PREFIX)[ApiKeyEnvironment]; keyLast4: string } | null {
  const keyPrefix = Object.values(ENV_PREFIX).find((prefix) => secret.startsWith(prefix));
  if (keyPrefix === undefined || secret.length <= keyPrefix.length) {
    return null;
  }
  return { keyPrefix, keyLast4: secret.slice(-4) };
}

function hashesEqual(storedHex: string, computedHex: string): boolean {
  const stored = Buffer.from(storedHex, "hex");
  const computed = Buffer.from(computedHex, "hex");
  if (stored.length !== computed.length || stored.length === 0) {
    return false;
  }
  return timingSafeEqual(stored, computed);
}

/**
 * F1: tenant API-key issuance and revocation used to trust the bearer
 * token's `execution:admin` scope alone. That scope was, at the time,
 * handed to every member session regardless of role, so a `viewer` could
 * mint a `brain_sk_live_...` key with no `expires_at` or revoke another
 * integration's key. Scopes are now derived from `members.role` at mint
 * time (see production-tenancy/routes.ts), but a token already minted
 * before a demotion could still carry the old scope until it expires, so
 * this also re-checks the live `members` row, mirroring the DB-backed
 * `requireAdmin` check `services/execution/src/members/routes.ts` already
 * does for member mutation routes.
 */
async function requireTenantAdmin(
  request: FastifyRequest,
  pool: Pool,
  tenantId: string,
): Promise<Principal> {
  const principal = requireTenantRead(request, tenantId);
  requireScope(principal.scopes, "execution:admin");
  if (principal.type !== "user") {
    throw brainError(
      "auth_scope_insufficient",
      "tenant key management requires principal_type=user",
    );
  }
  await requireAdminMember(pool, tenantId, principal.id);
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
    if (typeof value !== "string" || !API_KEY_SYNTHETIC_DEMO_PERMITTED_SCOPES.has(value as Scope)) {
      throw brainError(
        "request_body_invalid",
        `scope not permitted for an api key: ${String(value)}`,
        {
          details: { scope: value, permitted: [...API_KEY_SYNTHETIC_DEMO_PERMITTED_SCOPES] },
        },
      );
    }
    if (!scopes.includes(value as Scope)) scopes.push(value as Scope);
  }
  return scopes;
}

function hasDemoRawScope(scopes: readonly Scope[]): boolean {
  return scopes.includes("raw:read") || scopes.includes("raw:write");
}

function isVerifiedSyntheticDemoKey(
  key: Pick<ApiKeyRow, "environment" | "key_prefix"> & Partial<TenantApiKeyState>,
): boolean {
  return (
    key.environment === "sandbox" &&
    key.key_prefix === ENV_PREFIX.sandbox &&
    key.provisioning_state === "ready_demo" &&
    key.data_profile === "synthetic_brightline_v1" &&
    key.access_stage === "demo"
  );
}

function assertScopesAllowedForTenant(
  environment: ApiKeyEnvironment,
  scopes: readonly Scope[],
  tenant: TenantApiKeyState,
): void {
  if (!hasDemoRawScope(scopes)) return;
  if (
    isVerifiedSyntheticDemoKey({
      environment,
      key_prefix: ENV_PREFIX[environment],
      ...tenant,
    })
  ) {
    return;
  }
  throw brainError(
    "request_body_invalid",
    "raw scopes require a sandbox key on a ready synthetic demo tenant",
    {
      details: {
        environment,
        provisioning_state: tenant.provisioning_state,
        data_profile: tenant.data_profile,
        access_stage: tenant.access_stage,
        permitted: [...API_KEY_PERMITTED_SCOPES],
      },
    },
  );
}

function parseUsageWindow(input: unknown): string {
  if (input === undefined) return DEFAULT_USAGE_WINDOW;
  if (
    typeof input !== "string" ||
    (input !== "current_month" && !/^[1-9][0-9]*(d|h)$/.test(input))
  ) {
    throw brainError(
      "request_params_invalid",
      "window must be current_month or an interval like 30d or 24h",
    );
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
    const state = await loadTenantApiKeyState(client, input.tenantId);
    if (state === null) {
      throw brainError("tenant_not_found", "tenant does not exist", { statusOverride: 404 });
    }
    assertScopesAllowedForTenant(input.environment, input.scopes, state);
    return insertGeneratedKey(client, input);
  });
}

async function loadTenantApiKeyState(
  client: TenantScopedClient,
  tenantId: string,
): Promise<TenantApiKeyState | null> {
  const tenant = await client.query<TenantApiKeyState>(
    `SELECT provisioning_state, data_profile, access_stage
       FROM tenants
      WHERE id = $1`,
    [tenantId],
  );
  return tenant.rows[0] ?? null;
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
                   hashed_secret, created_at, last_used_at, revoked_at, expires_at, rotated_from_id`,
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
            hashed_secret, created_at, last_used_at, revoked_at, expires_at, rotated_from_id
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
  usage_date: Date | string;
  key_id: string;
  environment: ApiKeyEnvironment | null;
  method: string;
  operation_id: string;
  route_template: string;
  required_scope: string | null;
  product_family: string | null;
  outcome: string;
  metering_policy_version: string;
  request_count: string | number;
  billable_units: string | number;
  first_request_at: Date | string | null;
  last_request_at: Date | string | null;
}

interface UsageEntitlementRow {
  tier_id: string;
  display_name: string;
  entitlement_version: number;
  status: "active" | "suspended";
  window_seconds: number;
  key_limit: number;
  tenant_limit: number;
  override_key_limit: number | null;
  override_version: number | null;
  override_expires_at: Date | string | null;
}

async function loadUsageEntitlement(
  client: TenantScopedClient,
  input: { tenantId: string; environment: ApiKeyEnvironment; keyId?: string },
) {
  const params: unknown[] = [input.tenantId, input.environment];
  const overrideJoin =
    input.keyId === undefined
      ? "LEFT JOIN api_key_rate_limit_overrides override ON FALSE"
      : `LEFT JOIN api_key_rate_limit_overrides override
           ON override.tenant_id = ent.tenant_id AND override.key_id = $3`;
  if (input.keyId !== undefined) params.push(input.keyId);
  const { rows } = await client.query<UsageEntitlementRow>(
    `SELECT ent.tier_id, tier.display_name, ent.version AS entitlement_version,
            ent.status, tier.window_seconds, tier.key_limit, tier.tenant_limit,
            override.key_limit AS override_key_limit,
            override.version AS override_version,
            override.expires_at AS override_expires_at
       FROM tenant_api_entitlements ent
       JOIN api_rate_limit_tiers tier ON tier.id = ent.tier_id
       ${overrideJoin}
      WHERE ent.tenant_id = $1 AND ent.environment = $2`,
    params,
  );
  const row = rows[0];
  if (row === undefined) return null;
  const overrideActive =
    row.override_key_limit !== null &&
    (row.override_expires_at === null || Date.parse(String(row.override_expires_at)) > Date.now());
  return {
    tier_id: row.tier_id,
    display_name: row.display_name,
    entitlement_version: row.entitlement_version,
    status: row.status,
    window_seconds: row.window_seconds,
    key_limit: row.key_limit,
    tenant_limit: row.tenant_limit,
    effective_key_limit: overrideActive
      ? Math.min(row.key_limit, row.override_key_limit!)
      : row.key_limit,
    key_override:
      overrideActive && row.override_key_limit !== null
        ? {
            key_limit: Math.min(row.key_limit, row.override_key_limit),
            version: row.override_version,
            expires_at: toIso(row.override_expires_at),
          }
        : null,
  };
}

async function queryUsage(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    periodStart: Date;
    periodEnd: Date;
    environment?: ApiKeyEnvironment;
    keyId?: string;
  },
): Promise<UsageRow[]> {
  const params: unknown[] = [input.tenantId, input.periodStart, input.periodEnd];
  const filters = ["e.tenant_id = $1", "e.occurred_at >= $2", "e.occurred_at < $3"];
  if (input.environment !== undefined) {
    params.push(input.environment);
    filters.push(`e.environment = $${params.length}`);
  }
  if (input.keyId !== undefined) {
    params.push(input.keyId);
    filters.push(`e.key_id = $${params.length}`);
  }
  const { rows } = await client.query<UsageRow>(
    `SELECT e.key_id,
            e.environment,
            (e.occurred_at AT TIME ZONE 'UTC')::date AS usage_date,
            e.method,
            e.operation_id,
            e.route_template,
            e.required_scope,
            e.product_family,
            e.outcome,
            e.metering_policy_version,
            count(*) AS request_count,
            sum(e.billable_units) AS billable_units,
            min(e.occurred_at) AS first_request_at,
            max(e.occurred_at) AS last_request_at
       FROM api_request_meter_events e
      WHERE ${filters.join(" AND ")}
      GROUP BY e.key_id, e.environment, (e.occurred_at AT TIME ZONE 'UTC')::date,
               e.method, e.operation_id,
               e.route_template, e.required_scope, e.product_family, e.outcome,
               e.metering_policy_version
      ORDER BY request_count DESC, e.key_id ASC`,
    params,
  );
  return rows;
}

interface UsageCompletenessRow {
  status: "matched" | "mismatch" | "incomplete";
  meter_persistence_failures: string | number;
  created_at: Date | string;
}

async function loadUsageCompleteness(
  client: TenantScopedClient,
  input: {
    tenantId: string;
    periodStart: Date;
    periodEnd: Date;
    environment?: ApiKeyEnvironment;
  },
) {
  const params: unknown[] = [input.tenantId, input.periodStart, input.periodEnd];
  const environmentFilter =
    input.environment === undefined ? "" : `AND environment = $${params.push(input.environment)}`;
  const { rows } = await client.query<UsageCompletenessRow>(
    `SELECT status, meter_persistence_failures, created_at
       FROM api_usage_reconciliation_runs
      WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3
        ${environmentFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    params,
  );
  const reconciliation = rows[0];
  const closed = await client.query<{ id: string }>(
    `SELECT id FROM api_billing_periods
      WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3
        ${environmentFilter}
      LIMIT 1`,
    params,
  );
  return {
    closed: closed.rows[0] !== undefined,
    status:
      closed.rows[0] !== undefined
        ? "closed"
        : reconciliation?.status === "matched"
          ? "reconciled"
          : (reconciliation?.status ?? "unreconciled"),
    lastReconciledAt: reconciliation === undefined ? null : toIso(reconciliation.created_at),
    meterPersistenceFailures: Number(reconciliation?.meter_persistence_failures ?? 0),
  };
}

function usageBounds(window: string, now: Date): { periodStart: Date; periodEnd: Date } {
  if (window === "current_month") {
    return {
      periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
  }
  const amount = Number(window.slice(0, -1));
  const milliseconds = amount * (window.endsWith("d") ? 86_400_000 : 3_600_000);
  return { periodStart: new Date(now.getTime() - milliseconds), periodEnd: now };
}

function summarizeUsage(rows: UsageRow[]) {
  const methods = new Map<string, { count: number; daily: Map<string, number> }>();
  const scopes = new Map<string, number>();
  const routes = new Map<string, number>();
  const outcomes = new Map<string, number>();
  const daily = new Map<string, number>();
  for (const row of rows) {
    const count = Number(row.request_count);
    const date = toDateKey(row.usage_date);
    const method = methods.get(row.method) ?? { count: 0, daily: new Map<string, number>() };
    method.count += count;
    add(method.daily, date, count);
    methods.set(row.method, method);
    add(scopes, row.required_scope ?? "unclassified", count);
    add(routes, row.operation_id, count);
    add(outcomes, row.outcome, count);
    add(daily, date, count);
  }
  return {
    methods: [...methods.entries()]
      .sort(([leftKey, left], [rightKey, right]) =>
        right.count === left.count ? leftKey.localeCompare(rightKey) : right.count - left.count,
      )
      .map(([method, value]) => ({
        method,
        request_count: value.count,
        daily: serializeDaily(value.daily),
      })),
    scopes: serializeBreakdown(scopes, "scope"),
    routes: serializeBreakdown(routes, "operation_id"),
    outcomes: serializeBreakdown(outcomes, "outcome"),
    daily: serializeDaily(daily),
  };
}

function serializeDaily(target: Map<string, number>) {
  return [...target.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, requestCount]) => ({ date, request_count: requestCount }));
}

function toDateKey(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function summarizeKeys(rows: UsageRow[]) {
  const keys = new Map<
    string,
    {
      key_id: string;
      environment: ApiKeyEnvironment | null;
      request_count: number;
      first_request_at: string | null;
      last_request_at: string | null;
    }
  >();
  for (const row of rows) {
    const existing = keys.get(row.key_id);
    const first = toIso(row.first_request_at);
    const last = toIso(row.last_request_at);
    if (existing === undefined) {
      keys.set(row.key_id, {
        key_id: row.key_id,
        environment: row.environment,
        request_count: Number(row.request_count),
        first_request_at: first,
        last_request_at: last,
      });
      continue;
    }
    existing.request_count += Number(row.request_count);
    if (
      first !== null &&
      (existing.first_request_at === null || first < existing.first_request_at)
    ) {
      existing.first_request_at = first;
    }
    if (last !== null && (existing.last_request_at === null || last > existing.last_request_at)) {
      existing.last_request_at = last;
    }
  }
  return [...keys.values()]
    .sort((left, right) =>
      right.request_count === left.request_count
        ? left.key_id.localeCompare(right.key_id)
        : right.request_count - left.request_count,
    )
    .map((key) => ({
      ...key,
      event_count: key.request_count,
      first_event_at: key.first_request_at,
      last_event_at: key.last_request_at,
    }));
}

function add(target: Map<string, number>, key: string, count: number): void {
  target.set(key, (target.get(key) ?? 0) + count);
}

function serializeBreakdown(target: Map<string, number>, keyName: string) {
  return [...target.entries()]
    .sort(([leftKey, leftCount], [rightKey, rightCount]) =>
      rightCount === leftCount ? leftKey.localeCompare(rightKey) : rightCount - leftCount,
    )
    .map(([key, requestCount]) => ({ [keyName]: key, request_count: requestCount }));
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
    expires_at: toIso(row.expires_at),
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
