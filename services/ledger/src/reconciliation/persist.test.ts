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
  it("raises a matched obligation's confidence when the counter-side is independently sourced", async () => {
    // Counter-side transaction provenance = 'extracted' (came from a Plaid feed,
    // not the agent). This is the canonical "independent corroboration" case
    // RFC 0004 §5.2 sanctions for lifting the obligation.
    const { pool, queries } = fakePool({
      "SELECT provenance FROM ledger_transactions": [{ provenance: "extracted" }],
      "UPDATE ledger_obligations": [{ id: OBL, confidence: 0.8 }],
    });
    const audit = new InMemoryAuditEmitter();

    const result = await persistMatch(pool, audit, makeCtx(), input());
    expect(result.created).toBe(true);

    const update = findQuery(queries, "UPDATE ledger_obligations");
    // upward-only (GREATEST), capped at the corroboration ceiling (LEAST), and
    // promotes agent_contributed -> extracted.
    expect(update.text).toContain("GREATEST(confidence, LEAST");
    expect(update.text).toContain("'agent_contributed','customer_asserted'");
    expect(update.values).toEqual([OBL, 0.8, 0.9]);

    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain("ledger.reconciliation.matched");
    expect(actions).toContain("ledger.obligation.corroborated");
    const corroborated = audit.events.find((e) => e.action === "ledger.obligation.corroborated");
    expect(corroborated?.outputs).toMatchObject({ obligation_id: OBL, confidence: 0.8 });
  });

  it("lifts when the counter-side is human-confirmed", async () => {
    // A human-confirmed transaction is also independent of the agent.
    const { pool, queries } = fakePool({
      "SELECT provenance FROM ledger_transactions": [{ provenance: "human_confirmed" }],
      "UPDATE ledger_obligations": [{ id: OBL, confidence: 0.7 }],
    });
    const audit = new InMemoryAuditEmitter();

    const result = await persistMatch(pool, audit, makeCtx(), input({ confidenceScore: 0.7 }));
    expect(result.created).toBe(true);
    expect(queries.find((q) => q.text.includes("UPDATE ledger_obligations"))).toBeDefined();
    expect(audit.events.map((e) => e.action)).toContain("ledger.obligation.corroborated");
  });

  it("C-2 regression: refuses to lift when the counter-side is agent_contributed (self-corroboration)", async () => {
    // The bug this guards: an agent contributes BOTH an obligation AND a
    // "corroborating" transaction, both at provenance=agent_contributed. The
    // unguarded code would promote the obligation to provenance=extracted with
    // confidence up to 0.9, defeating the 0.5 agent-contributed ceiling
    // entirely. Post-C-2: the match row is still recorded (useful evidence for
    // the matcher), but the obligation stays put.
    const { pool, queries } = fakePool({
      "SELECT provenance FROM ledger_transactions": [{ provenance: "agent_contributed" }],
    });
    const audit = new InMemoryAuditEmitter();

    const result = await persistMatch(pool, audit, makeCtx(), input());
    expect(result.created).toBe(true);
    expect(queries.find((q) => q.text.includes("UPDATE ledger_obligations"))).toBeUndefined();
    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain("ledger.reconciliation.matched");
    expect(actions).not.toContain("ledger.obligation.corroborated");
  });

  it("C-2 regression: refuses to lift when the counter-side is inferred or ambiguous", async () => {
    // Same independence rule: only `extracted` and `human_confirmed` count.
    // `inferred` and `ambiguous` are not independent corroboration.
    for (const prov of ["inferred", "ambiguous"]) {
      const { pool, queries } = fakePool({
        "SELECT provenance FROM ledger_transactions": [{ provenance: prov }],
      });
      const audit = new InMemoryAuditEmitter();
      const result = await persistMatch(pool, audit, makeCtx(), input());
      expect(result.created).toBe(true);
      expect(
        queries.find((q) => q.text.includes("UPDATE ledger_obligations")),
        `provenance=${prov} must not corroborate`,
      ).toBeUndefined();
      expect(audit.events.map((e) => e.action)).not.toContain("ledger.obligation.corroborated");
    }
  });

  it("C-2 regression: refuses to lift when the counter-side row is missing entirely", async () => {
    // The SELECT returns no rows (counter-side id does not resolve). Safe
    // default: no corroboration. The match row stands.
    const { pool, queries } = fakePool({
      "SELECT provenance FROM ledger_transactions": [],
    });
    const audit = new InMemoryAuditEmitter();

    const result = await persistMatch(pool, audit, makeCtx(), input());
    expect(result.created).toBe(true);
    expect(queries.find((q) => q.text.includes("UPDATE ledger_obligations"))).toBeUndefined();
    expect(audit.events.map((e) => e.action)).not.toContain("ledger.obligation.corroborated");
  });

  it("C-2 regression: refuses to lift when the counter-side type is outside the whitelist", async () => {
    // A future matcher pairs an obligation with some new entity type the
    // provenance lookup table does not know yet. Safe default: no lift, no
    // crash. Adding the new type is a one-line change in persist.ts.
    const { pool, queries } = fakePool({
      "UPDATE ledger_obligations": [{ id: OBL, confidence: 0.8 }],
    });
    const audit = new InMemoryAuditEmitter();

    const result = await persistMatch(
      pool,
      audit,
      makeCtx(),
      input({ rightEntityType: "future_unknown_type", rightEntityId: "x" }),
    );
    expect(result.created).toBe(true);
    expect(queries.find((q) => q.text.includes("UPDATE ledger_obligations"))).toBeUndefined();
    expect(audit.events.map((e) => e.action)).not.toContain("ledger.obligation.corroborated");
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
