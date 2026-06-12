import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { newTenantId, newUserId } from "@brain/shared";
import { resolveObligationView } from "./resolveObligation.js";

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

function observation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    obligation_id: "obl_doc",
    provenance: "agent_contributed",
    confidence: 0.5,
    amount_due: "1250.00",
    currency: "USD",
    due_date: "2026-07-01 00:00:00+00",
    status: "due",
    direction: "payable",
    counterparty_id: "cp_acme",
    source_ids: ["raw_doc"],
    evidence_ids: ["prs_doc"],
    metadata: {},
    ...over,
  };
}

const CONFIRMED_MATCH = {
  id: "rcn_1",
  left_entity_id: "obl_doc",
  right_entity_id: "obl_bill",
  status: "matched",
  confidence_score: 0.86,
};

describe("resolveObligationView", () => {
  it("resolves two linked observations into one fact with accounting authority", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [CONFIRMED_MATCH],
      "FROM ledger_obligations": [
        observation(),
        observation({
          obligation_id: "obl_bill",
          provenance: "extracted",
          confidence: 0.9,
          due_date: "2026-07-03 00:00:00+00",
          metadata: { merge: { gl_accounts: ["gl-6100-equipment"], remote_id: "netsuite-4411" } },
        }),
      ],
    });

    const view = await resolveObligationView(pool, ctx, "obl_doc");
    expect(view).not.toBeNull();
    // One reconciled fact, ALL observations retained (§13 / Phase 4 AC).
    expect(view!.observations).toHaveLength(2);
    // Accounting observation is authoritative for terms + GL.
    expect(view!.resolved.due_date.value).toBe("2026-07-03 00:00:00+00");
    expect(view!.resolved.due_date.authority_obligation_id).toBe("obl_bill");
    expect(view!.resolved.due_date.authority_provenance).toBe("extracted");
    expect(view!.resolved.gl_accounts?.value).toEqual(["gl-6100-equipment"]);
    // The disagreement is LISTED, not overwritten.
    expect(view!.conflicts).toEqual([
      {
        field: "due_date",
        values: expect.arrayContaining([
          expect.objectContaining({ obligation_id: "obl_doc" }),
          expect.objectContaining({ obligation_id: "obl_bill" }),
        ]),
      },
    ]);
    expect(view!.matches).toEqual([
      { match_id: "rcn_1", status: "matched", confidence_score: 0.86 },
    ]);
  });

  it("keeps duplicate_possible links out of authority and surfaces them for review", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [
        { ...CONFIRMED_MATCH, status: "duplicate_possible", confidence_score: 0.62 },
      ],
      "FROM ledger_obligations": [observation()],
    });
    const view = await resolveObligationView(pool, ctx, "obl_doc");
    // Only the subject observation: the candidate contributed nothing yet.
    expect(view!.observations).toHaveLength(1);
    expect(view!.resolved.amount_due.authority_obligation_id).toBe("obl_doc");
    expect(view!.pending_review).toEqual([
      { match_id: "rcn_1", counter_obligation_id: "obl_bill", confidence_score: 0.62 },
    ]);
    expect(view!.conflicts).toEqual([]);
  });

  it("an unlinked observation is authoritative for itself", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [],
      "FROM ledger_obligations": [observation()],
    });
    const view = await resolveObligationView(pool, ctx, "obl_doc");
    expect(view!.observations).toHaveLength(1);
    expect(view!.resolved.amount_due.authority_provenance).toBe("agent_contributed");
    expect(view!.resolved.gl_accounts).toBeNull();
  });

  it("returns null for an unknown obligation", async () => {
    const pool = fakePool({
      "FROM ledger_reconciliation_matches": [],
      "FROM ledger_obligations": [],
    });
    expect(await resolveObligationView(pool, ctx, "obl_ghost")).toBeNull();
  });
});
