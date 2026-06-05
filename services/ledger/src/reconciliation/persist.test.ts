/**
 * persistMatch — corroboration confidence write-back (RFC 0004 §5.2 / §7.1).
 *
 * A reconciliation match against an obligation raises that obligation's
 * confidence (upward-only, capped at 0.9) and promotes agent_contributed
 * provenance to extracted, so a corroborated obligation can earn its way past
 * a tenant `agent.confidence.gte` gate without a human confirm.
 */

import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter, newObligationId, newTransactionId } from "@brain/shared";
import { persistMatch, type PersistMatchInput } from "./persist.js";
import { fakePool, findQuery, makeCtx } from "./harness.js";

const OBL = newObligationId();
const TX = newTransactionId();

function input(overrides: Partial<PersistMatchInput> = {}): PersistMatchInput {
  return {
    matchType: "subscription_charge",
    leftEntityType: "obligation",
    leftEntityId: OBL,
    rightEntityType: "transaction",
    rightEntityId: TX,
    confidenceScore: 0.8,
    evidenceIds: ["prs_1"],
    explanation: "monthly subscription debit matches the obligation",
    ...overrides,
  };
}

describe("persistMatch — corroboration write-back", () => {
  it("raises a matched obligation's confidence and audits it", async () => {
    const { pool, queries } = fakePool({
      "UPDATE ledger_obligations": [{ id: OBL, confidence: 0.8 }],
    });
    const audit = new InMemoryAuditEmitter();

    const result = await persistMatch(pool, audit, makeCtx(), input());
    expect(result.created).toBe(true);

    const update = findQuery(queries, "UPDATE ledger_obligations");
    // upward-only (GREATEST), capped at the corroboration ceiling (LEAST), and
    // promotes agent_contributed -> extracted.
    expect(update.text).toContain("GREATEST(confidence, LEAST");
    expect(update.text).toContain("'agent_contributed' THEN 'extracted'");
    expect(update.values).toEqual([OBL, 0.8, 0.9]);

    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain("ledger.reconciliation.matched");
    expect(actions).toContain("ledger.obligation.corroborated");
    const corroborated = audit.events.find((e) => e.action === "ledger.obligation.corroborated");
    expect(corroborated?.outputs).toMatchObject({ obligation_id: OBL, confidence: 0.8 });
  });

  it("does not touch obligations when neither side is an obligation", async () => {
    const { pool, queries } = fakePool();
    const audit = new InMemoryAuditEmitter();

    await persistMatch(
      pool,
      audit,
      makeCtx(),
      input({ leftEntityType: "transaction", leftEntityId: TX, rightEntityType: "transaction" }),
    );

    expect(queries.find((q) => q.text.includes("UPDATE ledger_obligations"))).toBeUndefined();
    expect(audit.events.map((e) => e.action)).not.toContain("ledger.obligation.corroborated");
  });

  it("does not re-promote when the match already exists (idempotent)", async () => {
    const { pool, queries } = fakePool({
      "SELECT * FROM ledger_reconciliation_matches": [{ id: "rec_existing" }],
    });
    const audit = new InMemoryAuditEmitter();

    const result = await persistMatch(pool, audit, makeCtx(), input());
    expect(result.created).toBe(false);
    expect(queries.find((q) => q.text.includes("UPDATE ledger_obligations"))).toBeUndefined();
    expect(audit.events).toHaveLength(0);
  });
});
