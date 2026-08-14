/**
 * BRAIN-98: consent must only ever offer kind=external agents, never Brain's
 * own internal service agents (e.g. the BFF service agent
 * ensureBffServiceAgent creates in services/api/src/onboarding/service-token.ts)
 * -- see listEligibleAgents's comment in src/routes/oauth.ts. The fake pool
 * below only returns kind=external rows when the query text actually carries
 * the kind = 'external' filter, so this test fails the same way a regression
 * that dropped the WHERE clause would: by letting the internal row through.
 */

import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { newTenantId } from "@brain/shared";
import { listEligibleAgents, loadActiveAgent } from "../src/routes/oauth.js";

interface FixtureRow {
  id: string;
  display_name: string;
  role: string;
  scope_hash: Buffer | null;
  kind: "internal" | "external";
}

function fakePool(rows: FixtureRow[]): Pool {
  const client = {
    query: async (sql: string) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (/FROM agents/.test(sql)) {
        const filtered = /kind\s*=\s*'external'/.test(sql)
          ? rows.filter((r) => r.kind === "external")
          : rows;
        return { rows: filtered, rowCount: filtered.length };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return { connect: async () => client } as unknown as Pool;
}

describe("listEligibleAgents", () => {
  it("excludes an internal-kind agent and still includes an external one", async () => {
    const tenantId = newTenantId();
    const internal: FixtureRow = {
      id: "agent_01J0000000000000000000000A",
      display_name: "Brain BFF Service Agent",
      role: "payment",
      scope_hash: Buffer.from("ab".repeat(32), "hex"),
      kind: "internal",
    };
    const external: FixtureRow = {
      id: "agent_01J0000000000000000000000B",
      display_name: "Partner Agent",
      role: "partner",
      scope_hash: Buffer.from("cd".repeat(32), "hex"),
      kind: "external",
    };
    const pool = fakePool([internal, external]);

    const eligible = await listEligibleAgents(pool, tenantId);

    expect(eligible.map((a) => a.id)).toEqual([external.id]);
    expect(eligible.some((a) => a.id === internal.id)).toBe(false);
  });
});

describe("loadActiveAgent", () => {
  // The grant path, not the listing: a tampered agent_id posted straight to
  // /authorize/consent never passes through listEligibleAgents, so this is the
  // filter that actually stops an internal agent being delegated.
  it("does not resolve an internal-kind agent", async () => {
    const tenantId = newTenantId();
    const internal: FixtureRow = {
      id: "agent_01J0000000000000000000000A",
      display_name: "Brain BFF Service Agent",
      role: "payment",
      scope_hash: Buffer.from("ab".repeat(32), "hex"),
      kind: "internal",
    };

    const agent = await loadActiveAgent(fakePool([internal]), tenantId, internal.id);

    expect(agent).toBeNull();
  });

  it("still resolves an external-kind agent", async () => {
    const tenantId = newTenantId();
    const external: FixtureRow = {
      id: "agent_01J0000000000000000000000B",
      display_name: "Partner Agent",
      role: "partner",
      scope_hash: Buffer.from("cd".repeat(32), "hex"),
      kind: "external",
    };

    const agent = await loadActiveAgent(fakePool([external]), tenantId, external.id);

    expect(agent?.id).toBe(external.id);
  });
});
