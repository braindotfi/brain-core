import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { newTenantId, newUserId } from "@brain/shared";
import { resolveCounterpartyView } from "./resolveCounterparty.js";

function fakePool(routes: Record<string, Array<Record<string, unknown>>>): Pool {
  const client = {
    query: vi.fn(async (text: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) return { rows: [], rowCount: 0 };
      if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
      for (const [needle, rows] of Object.entries(routes)) {
        if (text.includes(needle)) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { connect: async () => client } as unknown as Pool;
}

const ctx = { tenantId: newTenantId(), actor: newUserId() };

function obs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    counterparty_id: "cp_vendor",
    name: "Acme Industrial Supply",
    type: "vendor",
    provenance: "extracted",
    confidence: 0.8,
    source_ids: ["raw_vendor"],
    metadata: {},
    ...over,
  };
}

describe("resolveCounterpartyView", () => {
  it("resolves merchant + vendor observations into one organization, facets unioned", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [
        {
          id: "rcn_cp1",
          left_entity_id: "cp_merchant",
          right_entity_id: "cp_vendor",
          status: "matched",
          confidence_score: 0.85,
        },
      ],
      "FROM ledger_counterparties": [
        obs(),
        obs({
          counterparty_id: "cp_merchant",
          type: "merchant",
          name: "ACME INDUSTRIAL SUPPLY",
          confidence: 0.7,
        }),
      ],
    });

    const view = await resolveCounterpartyView(pool, ctx, "cp_vendor");
    expect(view).not.toBeNull();
    expect(view!.observations).toHaveLength(2); // all retained
    expect(view!.resolved.types).toEqual(["merchant", "vendor"]); // facets, not a winner
    expect(view!.resolved.member_ids).toEqual(["cp_merchant", "cp_vendor"]);
    // Highest-confidence independent observation names the org.
    expect(view!.resolved.name.value).toBe("Acme Industrial Supply");
    expect(view!.resolved.name.authority_counterparty_id).toBe("cp_vendor");
    expect(view!.observations[0]!.source_ids).toEqual(["raw_vendor"]);
    // Display variants listed, never collapsed.
    expect(view!.name_variants).toHaveLength(2);
  });

  it("human_confirmed observations outrank extracted ones for the canonical name", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [
        {
          id: "rcn_cp2",
          left_entity_id: "cp_corrected",
          right_entity_id: "cp_vendor",
          status: "matched",
          confidence_score: 0.9,
        },
      ],
      "FROM ledger_counterparties": [
        obs({ confidence: 0.9 }),
        obs({
          counterparty_id: "cp_corrected",
          name: "Acme Industrial Supply Co.",
          provenance: "human_confirmed",
          confidence: 0.6,
        }),
      ],
    });
    const view = await resolveCounterpartyView(pool, ctx, "cp_vendor");
    expect(view!.resolved.name.value).toBe("Acme Industrial Supply Co.");
    expect(view!.resolved.name.authority_provenance).toBe("human_confirmed");
  });

  it("keeps duplicate_possible candidates out of the member set, surfaced for review", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [
        {
          id: "rcn_cp3",
          left_entity_id: "cp_maybe",
          right_entity_id: "cp_vendor",
          status: "duplicate_possible",
          confidence_score: 0.6,
        },
      ],
      "FROM ledger_counterparties": [obs()],
    });
    const view = await resolveCounterpartyView(pool, ctx, "cp_vendor");
    expect(view!.observations).toHaveLength(1);
    expect(view!.resolved.member_ids).toEqual(["cp_vendor"]);
    expect(view!.pending_review).toEqual([
      { match_id: "rcn_cp3", counter_counterparty_id: "cp_maybe", confidence_score: 0.6 },
    ]);
  });

  it("returns null for an unknown counterparty", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [],
      "FROM ledger_counterparties": [],
    });
    expect(await resolveCounterpartyView(pool, ctx, "cp_ghost")).toBeNull();
  });
});
