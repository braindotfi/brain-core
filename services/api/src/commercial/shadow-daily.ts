import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Pool } from "pg";
import { withTenantScope } from "@brain/shared";
import { reconcileUsagePeriod } from "../usage/billing-service.js";
import { reconcileMcpShadowUsage } from "./mcp-usage-reconciliation.js";
import { CommercialShadowRepository } from "./shadow-repository.js";

export const COMMERCIAL_SHADOW_SCHEDULER_REVISION = "commercial_shadow_daily_v1";
export const COMMERCIAL_SHADOW_SCHEDULE_HOUR_UTC = 1;
export const COMMERCIAL_SHADOW_SCHEDULE_MINUTE_UTC = 15;
export const SHADOW_MCP_SCOPES = "ledger:read wiki:read";
export const COMMERCIAL_SHADOW_FIRST_RUN_DATE = "2026-10-01";
export const COMMERCIAL_SHADOW_LAST_RUN_DATE_EXCLUSIVE = "2026-11-01";

export interface ShadowDailyCredentialBundle {
  readonly tenant_id: string;
  readonly shadow_period_id: string;
  readonly agent_id: string;
  readonly agent_key_id: string;
  readonly api_key_id: string;
  readonly BRAIN_AGENT_API_KEY: string;
  readonly BRAIN_API_KEY: string;
}

export interface ShadowDailyTargets {
  readonly api: number;
  readonly mcp: number;
}

export interface ShadowDailyRunResult {
  readonly status: "not_running" | "outside_window" | "already_complete" | "completed";
  readonly tenant_id?: string;
  readonly shadow_period_id?: string;
  readonly run_date?: string;
  readonly api_requests?: number;
  readonly mcp_requests?: number;
  readonly api_reconciliation_status?: string;
  readonly mcp_reconciliation_status?: string;
  readonly observation_id?: string;
}

interface ShadowState {
  readonly state: string;
  readonly tenant_id?: string;
  readonly shadow_period_id?: string;
  readonly started_at?: string;
  readonly growth_entitlement_valid?: boolean;
  readonly api_rate_entitlement_valid?: boolean;
  readonly billing_exclusion_present?: boolean;
  readonly zero_billing_state?: boolean;
  readonly bff_agent_key_active?: boolean;
  readonly commercial_api_key_active?: boolean;
  readonly protected_tenant_match?: boolean;
  readonly provenance?: Record<string, unknown>;
}

interface ExistingRunRow {
  readonly tenant_id: string;
}

interface CountRow {
  readonly count: string | number;
}

export function targetsForDate(date: Date): ShadowDailyTargets {
  const day = date.getUTCDay();
  return day === 0 || day === 6 ? { api: 500, mcp: 50 } : { api: 1000, mcp: 100 };
}

export function scheduledForDate(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      COMMERCIAL_SHADOW_SCHEDULE_HOUR_UTC,
      COMMERCIAL_SHADOW_SCHEDULE_MINUTE_UTC,
    ),
  );
}

export function nextScheduledRun(now: Date): Date {
  const candidate = scheduledForDate(now);
  if (candidate.getTime() > now.getTime()) return candidate;
  return scheduledForDate(new Date(now.getTime() + 86_400_000));
}

export async function writeSchedulerHeartbeat(
  pool: Pool,
  input: {
    readonly deployedSha: string;
    readonly state: "ready" | "unhealthy";
    readonly now: Date;
    readonly runReference: string;
  },
): Promise<void> {
  await pool.query(`SELECT write_commercial_shadow_scheduler_heartbeat($1,$2,$3,$4,$5)`, [
    input.deployedSha,
    input.state,
    input.now,
    nextScheduledRun(input.now),
    input.runReference,
  ]);
}

export async function readCredentialBundle(path: string): Promise<ShadowDailyCredentialBundle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("commercial shadow credential file must be a regular mode-0600 file");
    }
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(contents) as Record<string, unknown>;
  const required = [
    "tenant_id",
    "shadow_period_id",
    "agent_id",
    "agent_key_id",
    "api_key_id",
    "BRAIN_AGENT_API_KEY",
    "BRAIN_API_KEY",
  ] as const;
  for (const key of required) {
    if (typeof parsed[key] !== "string" || parsed[key].length === 0) {
      throw new Error(`commercial shadow credential bundle is missing ${key}`);
    }
  }
  if (!String(parsed.BRAIN_AGENT_API_KEY).startsWith("brain_ak_live_")) {
    throw new Error("commercial shadow agent credential is not live");
  }
  if (!String(parsed.BRAIN_API_KEY).startsWith("brain_sk_live_")) {
    throw new Error("commercial shadow API credential is not live");
  }
  return parsed as unknown as ShadowDailyCredentialBundle;
}

export async function runCommercialShadowDaily(
  pool: Pool,
  input: {
    readonly deployedSha: string;
    readonly runReference: string;
    readonly credentialPath: string;
    readonly now?: Date;
    readonly fetch?: typeof globalThis.fetch;
    readonly apiBase?: string;
    readonly authTokenUrl?: string;
    readonly mcpUrl?: string;
  },
): Promise<ShadowDailyRunResult> {
  assertSha(input.deployedSha);
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const now = input.now ?? new Date();
  const stateResult = await pool.query<{ result: ShadowState }>(
    `SELECT inspect_internal_commercial_shadow() AS result`,
  );
  const state = stateResult.rows[0]?.result ?? { state: "not_started" };
  if (state.state !== "running") {
    await writeSchedulerHeartbeat(pool, {
      deployedSha: input.deployedSha,
      state: "ready",
      now,
      runReference: input.runReference,
    });
    return { status: "not_running" };
  }
  assertRunningStateSafe(state);
  const tenantId = requiredState(state.tenant_id, "tenant_id");
  const shadowPeriodId = requiredState(state.shadow_period_id, "shadow_period_id");
  const periodStart = new Date(requiredState(state.started_at, "started_at"));
  const runDate = utcDate(now);
  if (
    runDate < COMMERCIAL_SHADOW_FIRST_RUN_DATE ||
    runDate >= COMMERCIAL_SHADOW_LAST_RUN_DATE_EXCLUSIVE
  ) {
    await writeSchedulerHeartbeat(pool, {
      deployedSha: input.deployedSha,
      state: "ready",
      now,
      runReference: input.runReference,
    });
    return { status: "outside_window", tenant_id: tenantId, shadow_period_id: shadowPeriodId };
  }
  const scheduledFor = scheduledForDate(now);
  const existing = await withTenantScope(pool, tenantId, (client) =>
    client.query<ExistingRunRow>(
      `SELECT tenant_id FROM commercial_shadow_daily_runs
        WHERE tenant_id = $1 AND shadow_period_id = $2 AND run_date = $3::date`,
      [tenantId, shadowPeriodId, runDate],
    ),
  );
  if (existing.rows[0] !== undefined) {
    await writeSchedulerHeartbeat(pool, {
      deployedSha: input.deployedSha,
      state: "ready",
      now,
      runReference: input.runReference,
    });
    return { status: "already_complete", tenant_id: tenantId, shadow_period_id: shadowPeriodId };
  }

  const credential = await readCredentialBundle(input.credentialPath);
  if (credential.tenant_id !== tenantId || credential.shadow_period_id !== shadowPeriodId) {
    throw new Error("credential bundle does not match the active shadow contract");
  }
  const targets = targetsForDate(now);
  const dayStart = new Date(`${runDate}T00:00:00.000Z`);
  const [apiObserved, mcpObserved] = await Promise.all([
    countApiRequests(pool, tenantId, credential.api_key_id, dayStart, now),
    countMcpRequests(pool, tenantId, shadowPeriodId, credential.agent_id, dayStart, now),
  ]);
  if (apiObserved > targets.api || mcpObserved > targets.mcp) {
    throw new Error("commercial shadow daily request count exceeds its deterministic target");
  }

  const startedAt = new Date();
  const apiBase = input.apiBase ?? "https://api.brain.fi";
  const authTokenUrl = input.authTokenUrl ?? "https://auth.brain.fi/token";
  const mcpUrl = input.mcpUrl ?? "https://mcp.brain.fi/";
  const accessToken = await exchangeAgentCredential(fetchImpl, authTokenUrl, credential);
  await Promise.all([
    runBounded(targets.api - apiObserved, 20, (index) =>
      callApi(fetchImpl, apiBase, credential.BRAIN_API_KEY, apiObserved + index),
    ),
    runBounded(targets.mcp - mcpObserved, 10, (index) =>
      callMcp(fetchImpl, mcpUrl, accessToken, mcpObserved + index),
    ),
  ]);

  const completedAt = new Date();
  const [apiCompleted, mcpCompleted] = await Promise.all([
    countApiRequests(pool, tenantId, credential.api_key_id, dayStart, completedAt),
    countMcpRequests(pool, tenantId, shadowPeriodId, credential.agent_id, dayStart, completedAt),
  ]);
  if (apiCompleted !== targets.api || mcpCompleted !== targets.mcp) {
    throw new Error("durable meters do not contain the complete deterministic daily workload");
  }

  const idempotencySuffix = `${shadowPeriodId}:${runDate}:${completedAt.toISOString()}`;
  const apiReconciliation = await reconcileUsagePeriod(pool, {
    tenantId,
    environment: "live",
    periodStart,
    periodEnd: completedAt,
    idempotencyKey: `commercial-shadow-api:${idempotencySuffix}`,
    actor: "system:commercial-shadow-daily",
  });
  const mcpReconciliation = await reconcileMcpShadowUsage(pool, {
    tenantId,
    shadowPeriodId,
    environment: "live",
    periodStart,
    periodEnd: completedAt,
    idempotencyKey: `commercial-shadow-mcp:${idempotencySuffix}`,
    actor: "system:commercial-shadow-daily",
  });
  if (apiReconciliation.status !== "matched" || mcpReconciliation.status !== "matched") {
    throw new Error("commercial shadow reconciliation did not match independent observations");
  }
  const observation = await new CommercialShadowRepository(pool, true).observe({
    tenantId,
    shadowPeriodId,
  });
  if (!observation.apiEvidenceComplete || !observation.mcpEvidenceComplete) {
    throw new Error("commercial shadow observation evidence is incomplete");
  }
  await pool.query(
    `SELECT record_internal_commercial_shadow_daily_run(
       $1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb
     )`,
    [
      tenantId,
      shadowPeriodId,
      runDate,
      scheduledFor,
      input.deployedSha,
      startedAt,
      completedAt,
      targets.api,
      apiCompleted,
      targets.mcp,
      mcpCompleted,
      apiReconciliation.id,
      mcpReconciliation.id,
      observation.id,
      input.runReference,
      JSON.stringify({
        workload_revision: COMMERCIAL_SHADOW_SCHEDULER_REVISION,
        api_route_mix: apiRouteMix(targets.api),
        mcp_tool_mix: mcpToolMix(targets.mcp),
        api_units: observation.apiUnits.toString(),
        mcp_units: observation.mcpUnits.toString(),
        api_unit_result: observation.result.apiUnitResult,
        mcp_unit_result: observation.result.mcpUnitResult,
        enforcement_applied: false,
      }),
    ],
  );
  await writeSchedulerHeartbeat(pool, {
    deployedSha: input.deployedSha,
    state: "ready",
    now: completedAt,
    runReference: input.runReference,
  });
  return {
    status: "completed",
    tenant_id: tenantId,
    shadow_period_id: shadowPeriodId,
    run_date: runDate,
    api_requests: apiCompleted,
    mcp_requests: mcpCompleted,
    api_reconciliation_status: apiReconciliation.status,
    mcp_reconciliation_status: mcpReconciliation.status,
    observation_id: observation.id,
  };
}

export async function reportCommercialShadowDay(pool: Pool, date: string): Promise<unknown> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("report date must be YYYY-MM-DD");
  const result = await pool.query<{ result: unknown }>(
    `SELECT report_internal_commercial_shadow_day($1::date) AS result`,
    [date],
  );
  return result.rows[0]?.result;
}

async function exchangeAgentCredential(
  fetchImpl: typeof globalThis.fetch,
  tokenUrl: string,
  credential: ShadowDailyCredentialBundle,
): Promise<string> {
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential.BRAIN_AGENT_API_KEY,
      subject_token_type: "urn:brain:params:oauth:token-type:agent-api-key",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: "https://api.brain.fi/",
      scope: SHADOW_MCP_SCOPES,
    }),
  });
  if (!response.ok) throw new Error(`agent credential exchange failed with ${response.status}`);
  const payload = (await response.json()) as Record<string, unknown>;
  if (
    typeof payload.access_token !== "string" ||
    payload.token_type !== "Bearer" ||
    payload.expires_in !== 300 ||
    payload.scope !== SHADOW_MCP_SCOPES ||
    "refresh_token" in payload
  ) {
    throw new Error("agent credential exchange returned an invalid response");
  }
  const claims = decodeJwt(payload.access_token);
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.sub !== credential.agent_id ||
    claims.tenant_id !== credential.tenant_id ||
    claims.principal_type !== "agent" ||
    claims.credential_id !== credential.agent_key_id ||
    claims.aud !== "https://api.brain.fi/" ||
    !Array.isArray(claims.scopes) ||
    claims.scopes.join(" ") !== SHADOW_MCP_SCOPES ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.exp - claims.iat !== 300 ||
    claims.exp <= now
  ) {
    throw new Error("exchanged JWT claims do not match the shadow credential");
  }
  return payload.access_token;
}

async function callApi(
  fetchImpl: typeof globalThis.fetch,
  base: string,
  credential: string,
  ordinal: number,
): Promise<void> {
  const path = apiPath(ordinal);
  const response = await fetchImpl(`${base}${path}`, {
    headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`API workload request failed on ${path}: ${response.status}`);
  await response.arrayBuffer();
}

async function callMcp(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  token: string,
  ordinal: number,
): Promise<void> {
  const tool = mcpTool(ordinal);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ordinal + 1,
      method: "tools/call",
      params: { name: tool.name, arguments: tool.arguments },
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || "error" in body || !("result" in body)) {
    throw new Error(`MCP workload request failed for ${tool.name}: ${response.status}`);
  }
}

function apiPath(ordinal: number): string {
  const slot = ordinal % 10;
  if (slot < 4) return "/v1/ledger/accounts?limit=25";
  if (slot < 7) return "/v1/ledger/transactions?limit=25";
  if (slot === 7) return "/v1/ledger/obligations?limit=25";
  if (slot === 8) return "/v1/audit/events?limit=25";
  return "/v1/governance/agents";
}

function mcpTool(ordinal: number): { name: string; arguments: Record<string, unknown> } {
  const slot = ordinal % 10;
  if (slot < 5) return { name: "ledger.accounts.list", arguments: { limit: 25 } };
  if (slot < 8) return { name: "ledger.transactions.list", arguments: { limit: 25 } };
  return { name: "ledger.obligations.list", arguments: { limit: 25 } };
}

function apiRouteMix(total: number): Record<string, number> {
  return summarizeMix(total, apiPath);
}

function mcpToolMix(total: number): Record<string, number> {
  return summarizeMix(total, (index) => mcpTool(index).name);
}

function summarizeMix(total: number, valueAt: (index: number) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (let index = 0; index < total; index += 1) {
    const value = valueAt(index);
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

async function runBounded(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < count) {
      const index = next;
      next += 1;
      await task(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
}

async function countApiRequests(
  pool: Pool,
  tenantId: string,
  keyId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const result = await withTenantScope(pool, tenantId, (client) =>
    client.query<CountRow>(
      `SELECT count(*) AS count FROM api_gateway_request_observations
        WHERE tenant_id = $1 AND key_id = $2 AND occurred_at >= $3 AND occurred_at < $4`,
      [tenantId, keyId, start, end],
    ),
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function countMcpRequests(
  pool: Pool,
  tenantId: string,
  shadowPeriodId: string,
  agentId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const result = await withTenantScope(pool, tenantId, (client) =>
    client.query<CountRow>(
      `SELECT count(*) AS count FROM mcp_transport_tool_observations
        WHERE tenant_id = $1 AND shadow_period_id = $2 AND principal_id = $3
          AND occurred_at >= $4 AND occurred_at < $5`,
      [tenantId, shadowPeriodId, agentId, start, end],
    ),
  );
  return Number(result.rows[0]?.count ?? 0);
}

function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("exchanged token is not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function requiredState(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`shadow state is missing ${name}`);
  return value;
}

function assertSha(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("deployed SHA must be 40 lowercase hex");
}

function assertRunningStateSafe(state: ShadowState): void {
  for (const condition of [
    "growth_entitlement_valid",
    "api_rate_entitlement_valid",
    "billing_exclusion_present",
    "zero_billing_state",
    "bff_agent_key_active",
    "commercial_api_key_active",
  ] as const) {
    if (state[condition] !== true)
      throw new Error(`shadow workload safety check failed: ${condition}`);
  }
  if (state.protected_tenant_match !== false) {
    throw new Error("shadow workload safety check failed: protected tenant match");
  }
  if (
    state.provenance?.["kind"] !== "production" ||
    state.provenance["data_profile"] !== "internal_commercial_shadow_v1" ||
    state.provenance["access_stage"] !== "production"
  ) {
    throw new Error("shadow workload safety check failed: tenant provenance");
  }
}
