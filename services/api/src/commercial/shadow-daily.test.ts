import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import type * as BrainShared from "@brain/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockObserve } = vi.hoisted(() => ({ mockObserve: vi.fn() }));

vi.mock("@brain/shared", async (importActual) => {
  const actual = await importActual<typeof BrainShared>();
  return {
    ...actual,
    withTenantScope: vi.fn(
      async (pool: unknown, _tenantId: unknown, fn: (client: unknown) => Promise<unknown>) =>
        fn(pool),
    ),
  };
});
vi.mock("../usage/billing-service.js", () => ({ reconcileUsagePeriod: vi.fn() }));
vi.mock("./mcp-usage-reconciliation.js", () => ({ reconcileMcpShadowUsage: vi.fn() }));
vi.mock("./shadow-repository.js", () => ({
  CommercialShadowRepository: class {
    public observe = mockObserve;
  },
}));

import { reconcileUsagePeriod } from "../usage/billing-service.js";
import { reconcileMcpShadowUsage } from "./mcp-usage-reconciliation.js";
import {
  nextScheduledRun,
  readCredentialBundle,
  reportCommercialShadowDay,
  runCommercialShadowDaily,
  scheduledForDate,
  targetsForDate,
} from "./shadow-daily.js";

const temporaryDirectories: string[] = [];
const TENANT_ID = "tnt_01M30000000000000000000000";
const SHADOW_PERIOD_ID = "csp_01M30000000000000000000000";
const AGENT_ID = "agent_01M3000000000000000000000";
const AGENT_KEY_ID = "agkey_01M300000000000000000000";
const API_KEY_ID = "akey_01M3000000000000000000000";
const DEPLOYED_SHA = "a".repeat(40);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("commercial shadow daily workload", () => {
  it("uses the approved weekday and weekend request counts", () => {
    expect(targetsForDate(new Date("2026-10-02T12:00:00Z"))).toEqual({ api: 1000, mcp: 100 });
    expect(targetsForDate(new Date("2026-10-03T12:00:00Z"))).toEqual({ api: 500, mcp: 50 });
    expect(targetsForDate(new Date("2026-10-04T12:00:00Z"))).toEqual({ api: 500, mcp: 50 });
  });

  it("pins the daily schedule to 01:15 UTC and advances after the boundary", () => {
    expect(scheduledForDate(new Date("2026-10-02T00:00:00Z")).toISOString()).toBe(
      "2026-10-02T01:15:00.000Z",
    );
    expect(nextScheduledRun(new Date("2026-10-02T01:14:59Z")).toISOString()).toBe(
      "2026-10-02T01:15:00.000Z",
    );
    expect(nextScheduledRun(new Date("2026-10-02T01:15:00Z")).toISOString()).toBe(
      "2026-10-03T01:15:00.000Z",
    );
  });

  it("accepts only a regular mode-0600 live credential bundle", async () => {
    const path = await makeCredentialFile();
    await expect(readCredentialBundle(path)).resolves.toMatchObject({
      BRAIN_AGENT_API_KEY: "brain_ak_live_example",
      BRAIN_API_KEY: "brain_sk_live_example",
    });
    await chmod(path, 0o640);
    await expect(readCredentialBundle(path)).rejects.toThrow("mode-0600");
  });

  it("refuses to follow a credential-file symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brain-shadow-daily-link-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target.json");
    const link = join(directory, "credentials.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, link);
    await expect(readCredentialBundle(link)).rejects.toThrow();
  });

  it("rejects incomplete and non-live credential bundles", async () => {
    const incomplete = await makeCredentialFile({ agent_id: "" });
    await expect(readCredentialBundle(incomplete)).rejects.toThrow("agent_id");
    const testAgentKey = await makeCredentialFile({
      BRAIN_AGENT_API_KEY: "brain_ak_test_example",
    });
    await expect(readCredentialBundle(testAgentKey)).rejects.toThrow("not live");
    const testApiKey = await makeCredentialFile({ BRAIN_API_KEY: "brain_sk_test_example" });
    await expect(readCredentialBundle(testApiKey)).rejects.toThrow("not live");
  });

  it("reports not running and refreshes scheduler health without loading credentials", async () => {
    const pool = fakePool((sql) =>
      sql.includes("inspect_internal_commercial_shadow")
        ? { rows: [{ result: { state: "not_started" } }] }
        : { rows: [] },
    );
    await expect(
      runCommercialShadowDaily(pool, {
        deployedSha: DEPLOYED_SHA,
        runReference: "unit-not-running",
        credentialPath: "/does/not/exist",
        now: new Date("2026-10-02T01:15:00Z"),
      }),
    ).resolves.toEqual({ status: "not_running" });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("write_commercial_shadow_scheduler_heartbeat"),
      expect.arrayContaining([DEPLOYED_SHA, "ready"]),
    );
  });

  it.each([
    "growth_entitlement_valid",
    "api_rate_entitlement_valid",
    "billing_exclusion_present",
    "zero_billing_state",
    "bff_agent_key_active",
    "commercial_api_key_active",
  ] as const)("fails closed when %s is false", async (condition) => {
    const state = runningState();
    state[condition] = false;
    await expect(runWithState(state)).rejects.toThrow(condition);
  });

  it("fails closed on protected identity and invalid provenance", async () => {
    await expect(runWithState({ ...runningState(), protected_tenant_match: true })).rejects.toThrow(
      "protected tenant match",
    );
    await expect(
      runWithState({
        ...runningState(),
        provenance: { kind: "production", data_profile: null, access_stage: "production" },
      }),
    ).rejects.toThrow("tenant provenance");
  });

  it("does no workload outside the fixed window or after a completed day", async () => {
    const outside = fakePool((sql) =>
      sql.includes("inspect_internal_commercial_shadow")
        ? { rows: [{ result: runningState() }] }
        : { rows: [] },
    );
    await expect(
      runCommercialShadowDaily(outside, {
        deployedSha: DEPLOYED_SHA,
        runReference: "unit-outside",
        credentialPath: "/does/not/exist",
        now: new Date("2026-11-01T01:15:00Z"),
      }),
    ).resolves.toMatchObject({ status: "outside_window", tenant_id: TENANT_ID });

    const complete = fakePool((sql) => {
      if (sql.includes("inspect_internal_commercial_shadow")) {
        return { rows: [{ result: runningState() }] };
      }
      if (sql.includes("FROM commercial_shadow_daily_runs")) {
        return { rows: [{ tenant_id: TENANT_ID }] };
      }
      return { rows: [] };
    });
    await expect(
      runCommercialShadowDaily(complete, {
        deployedSha: DEPLOYED_SHA,
        runReference: "unit-complete",
        credentialPath: "/does/not/exist",
        now: new Date("2026-10-02T01:15:00Z"),
      }),
    ).resolves.toMatchObject({ status: "already_complete", tenant_id: TENANT_ID });
  });

  it("runs the exact workload and records only matched complete evidence", async () => {
    const credentialPath = await makeCredentialFile();
    let apiCountQueries = 0;
    let mcpCountQueries = 0;
    const pool = fakePool((sql) => {
      if (sql.includes("inspect_internal_commercial_shadow")) {
        return { rows: [{ result: runningState() }] };
      }
      if (sql.includes("FROM commercial_shadow_daily_runs")) return { rows: [] };
      if (sql.includes("api_gateway_request_observations")) {
        apiCountQueries += 1;
        return { rows: [{ count: apiCountQueries === 1 ? "0" : "500" }] };
      }
      if (sql.includes("mcp_transport_tool_observations")) {
        mcpCountQueries += 1;
        return { rows: [{ count: mcpCountQueries === 1 ? "0" : "50" }] };
      }
      return { rows: [] };
    });
    vi.mocked(reconcileUsagePeriod).mockResolvedValue({
      id: "urr_unit",
      status: "matched",
    } as never);
    vi.mocked(reconcileMcpShadowUsage).mockResolvedValue({
      id: "murr_unit",
      status: "matched",
    } as never);
    mockObserve.mockResolvedValue({
      id: "cso_unit",
      apiEvidenceComplete: true,
      mcpEvidenceComplete: true,
      apiUnits: 500n,
      mcpUnits: 50n,
      result: { apiUnitResult: "within", mcpUnitResult: "within" },
    });
    const fetch = vi.fn(
      async (
        request: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url = String(request);
        if (url.endsWith("/token")) return tokenExchangeResponse();
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      },
    );
    await expect(
      runCommercialShadowDaily(pool, {
        deployedSha: DEPLOYED_SHA,
        runReference: "unit-success",
        credentialPath,
        now: new Date("2026-10-03T01:15:00Z"),
        fetch,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      api_requests: 500,
      mcp_requests: 50,
      api_reconciliation_status: "matched",
      mcp_reconciliation_status: "matched",
      observation_id: "cso_unit",
    });
    expect(fetch).toHaveBeenCalledTimes(551);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("record_internal_commercial_shadow_daily_run"),
      expect.arrayContaining([TENANT_ID, SHADOW_PERIOD_ID, "2026-10-03", DEPLOYED_SHA]),
    );
  });

  it("validates report dates before invoking the database contract", async () => {
    const pool = fakePool(() => ({ rows: [{ result: { status: "complete" } }] }));
    await expect(reportCommercialShadowDay(pool, "not-a-date")).rejects.toThrow("YYYY-MM-DD");
    await expect(reportCommercialShadowDay(pool, "2026-10-03")).resolves.toEqual({
      status: "complete",
    });
  });
});

function runningState(): Record<string, unknown> {
  return {
    state: "running",
    tenant_id: TENANT_ID,
    shadow_period_id: SHADOW_PERIOD_ID,
    started_at: "2026-10-01T00:00:00.000Z",
    growth_entitlement_valid: true,
    api_rate_entitlement_valid: true,
    billing_exclusion_present: true,
    zero_billing_state: true,
    bff_agent_key_active: true,
    commercial_api_key_active: true,
    protected_tenant_match: false,
    provenance: {
      kind: "production",
      data_profile: "internal_commercial_shadow_v1",
      access_stage: "production",
    },
  };
}

async function runWithState(state: Record<string, unknown>): Promise<unknown> {
  const pool = fakePool((sql) =>
    sql.includes("inspect_internal_commercial_shadow")
      ? { rows: [{ result: state }] }
      : { rows: [] },
  );
  return runCommercialShadowDaily(pool, {
    deployedSha: DEPLOYED_SHA,
    runReference: "unit-unsafe",
    credentialPath: "/does/not/exist",
    now: new Date("2026-10-02T01:15:00Z"),
  });
}

async function makeCredentialFile(overrides: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "brain-shadow-daily-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "credentials.json");
  await writeFile(
    path,
    JSON.stringify({
      tenant_id: TENANT_ID,
      shadow_period_id: SHADOW_PERIOD_ID,
      agent_id: AGENT_ID,
      agent_key_id: AGENT_KEY_ID,
      api_key_id: API_KEY_ID,
      BRAIN_AGENT_API_KEY: "brain_ak_live_example",
      BRAIN_API_KEY: "brain_sk_live_example",
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return path;
}

function fakePool(
  handler: (sql: string, values?: readonly unknown[]) => { rows: unknown[] },
): Pool {
  return {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => handler(sql, values)),
  } as unknown as Pool;
}

function tokenExchangeResponse(): Response {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    sub: AGENT_ID,
    tenant_id: TENANT_ID,
    principal_type: "agent",
    credential_id: AGENT_KEY_ID,
    aud: "https://api.brain.fi/",
    scopes: ["ledger:read", "wiki:read"],
    iat: issuedAt,
    exp: issuedAt + 300,
  };
  const token = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
  return new Response(
    JSON.stringify({
      access_token: token,
      token_type: "Bearer",
      expires_in: 300,
      scope: "ledger:read wiki:read",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
