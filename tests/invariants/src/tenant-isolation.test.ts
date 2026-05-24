/**
 * H-19 adversarial tenant isolation.
 *
 * Two complementary layers:
 *
 *  1. STORAGE-LAYER GUARD (runs DB-free, every PR): the withTenantScope helper
 *     refuses a malformed/non-tenant id BEFORE opening a connection — the
 *     defense-in-depth backstop that makes "shared-query-with-filter" impossible
 *     even if a caller forgets RLS. (RLS *presence* on every tenant table is
 *     separately asserted by rls-coverage.test.ts.)
 *
 *  2. CROSS-TENANT PROBING (integration — BLOCKED in the sandbox): spin up two
 *     tenants with data across all six layers + MCP + agent runs, then for every
 *     public route attempt A→B by id, A→B admin route, no-auth, malformed tenant,
 *     and JWT/path tenant mismatch — asserting 404/403/401, never B's data.
 *     This needs a live app + Postgres (RLS only enforces against a real DB), so
 *     the scenarios are recorded as `it.todo` (explicitly pending, never falsely
 *     green) and implemented once BRAIN_TEST_DATABASE_URL + the two-tenant
 *     fixtures are available. See the H-19 summary.
 */

import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenantScope, newTenantId, newAgentId } from "@brain/shared";

// ---------------------------------------------------------------------------
// 1. Storage-layer guard — runs without a database.
// ---------------------------------------------------------------------------
describe("H-19 tenant isolation — storage-layer guard (no DB)", () => {
  const neverConnect = {
    connect: () => {
      throw new Error("withTenantScope must NOT open a connection for an invalid tenant id");
    },
  } as unknown as Pool;

  it("refuses a malformed tenant id before opening a connection", async () => {
    await expect(
      withTenantScope(neverConnect, "not-a-tenant", async () => "x"),
    ).rejects.toMatchObject({ code: "auth_tenant_mismatch" });
  });

  it("refuses a well-formed id of the WRONG kind (e.g. an agent id)", async () => {
    await expect(
      withTenantScope(neverConnect, newAgentId(), async () => "x"),
    ).rejects.toMatchObject({ code: "auth_tenant_mismatch" });
  });

  it("accepts a valid tenant id and sets the scope on the connection", async () => {
    const queries: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
    } as unknown as Pool;
    const tenant = newTenantId();
    await withTenantScope(pool, tenant, async () => "ok");
    // SET LOCAL app.tenant_id must be issued inside the tx before any fn query.
    expect(queries.some((q) => q.includes("set_config('app.tenant_id'"))).toBe(true);
    expect(queries[0]).toBe("BEGIN");
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-tenant probing — integration, BLOCKED (needs a live app + Postgres).
//    Recorded as pending so the coverage requirement is explicit and tracked.
// ---------------------------------------------------------------------------
describe("H-19 cross-tenant probing (integration — needs two-tenant app + pg)", () => {
  // Generic HTTP probe matrix, per public route: A's JWT reading B's resource by
  // id, A→B admin route, no auth, malformed tenant id, JWT/path tenant mismatch.
  it.todo("every public route: A's JWT requesting B's resource by id → 404");
  it.todo("every tenant-scoped admin route: A's JWT against B → 403");
  it.todo("every route: no Authorization header → 401");
  it.todo("every route: malformed tenant id in token → 401/403");
  it.todo("every route: JWT tenant mismatches path/param tenant → 403/404");

  // Agent Run History (H-25) sub-resources.
  it.todo("A's JWT GET /v1/agents/runs/{B_run_id} → 404");
  it.todo("A's JWT on B's run /why, /evidence, /gate-trace, /proof → 404 each");

  // Proof API (H-07).
  it.todo("A's JWT GET /v1/proof/{B_action_id} → 404 (no existence leak)");

  // MCP surface.
  it.todo("agent registered for tenant A calling a tool against B → reject");
  it.todo("agent whose scope_hash was mutated → reject");

  // Execution outbox (H-04).
  it.todo("outbox worker claims a row → app.tenant_id scope is set before any rail dispatch");

  // Replay investigation.
  it.todo("A's JWT GET /payment-intents/{B_pi}/replay-investigation → 404");

  // Webhook dead-letters (H-20).
  it.todo("A's JWT GET/POST /v1/webhooks/{B_endpoint}/dead-letters|replay → 404");
});
