import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  newAuditEventId,
  newPaymentIntentId,
  newProposalId,
  newTenantId,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import { parseProposalDecisionStateQuery, queryProposalDecisionStates } from "./decision-state.js";

const TENANT = newTenantId();
const PROPOSAL = newProposalId();
const PAYMENT_INTENT = newPaymentIntentId();
const MISSING = newProposalId();
const AUDIT = newAuditEventId();

const CTX: ServiceCallContext = {
  tenantId: TENANT,
  actor: "user_01TEST0000000000000000000",
  principalType: "user",
  scopes: ["execution:read"],
};

describe("proposal decision-state query", () => {
  it("validates a bounded unique list of proposal ids", () => {
    expect(parseProposalDecisionStateQuery({ proposal_ids: [PROPOSAL, PAYMENT_INTENT] })).toEqual({
      proposal_ids: [PROPOSAL, PAYMENT_INTENT],
    });
    expect(() => parseProposalDecisionStateQuery({ proposal_ids: [] })).toThrowError(
      expect.objectContaining({ code: "request_body_invalid" }),
    );
    expect(() =>
      parseProposalDecisionStateQuery({ proposal_ids: [PROPOSAL, PROPOSAL] }),
    ).toThrowError(expect.objectContaining({ code: "request_body_invalid" }));
    expect(() => parseProposalDecisionStateQuery({ proposal_ids: ["bad"] })).toThrowError(
      expect.objectContaining({ code: "request_body_invalid" }),
    );
  });

  it("uses exactly two authoritative lookups and preserves request order", async () => {
    const sql: string[] = [];
    const pool = fakePool(sql);

    const result = await queryProposalDecisionStates(pool, CTX, {
      proposal_ids: [PAYMENT_INTENT, MISSING, PROPOSAL],
    });

    expect(result).toEqual({
      states: [
        {
          proposal_id: PAYMENT_INTENT,
          found: true,
          decision_state: "decided",
          status: "approved",
          decision: "approve",
          audit_id: AUDIT,
          decided_at: "2026-09-13T08:00:00.000Z",
        },
        {
          proposal_id: MISSING,
          found: false,
          decision_state: null,
          status: null,
          decision: null,
          audit_id: null,
          decided_at: null,
        },
        {
          proposal_id: PROPOSAL,
          found: true,
          decision_state: "pending",
          status: "pending",
          decision: null,
          audit_id: null,
          decided_at: null,
        },
      ],
    });

    const lookups = sql.filter((statement) => statement.includes(" AS proposal_id"));
    expect(lookups).toHaveLength(2);
    expect(lookups[0]).toContain("FROM proposals");
    expect(lookups[1]).toContain("FROM ledger_payment_intents");
    expect(lookups.join("\n")).not.toContain("audit_events");
  });

  it("pins the one-time backfill to canonical proposal.decided receipts", () => {
    const proposalBackfill = readFileSync(
      new URL("../../migrations/0038_backfill_proposal_decision_state.sql", import.meta.url),
      "utf8",
    );
    const paymentIntentBackfill = readFileSync(
      new URL(
        "../../../ledger/migrations/0074_backfill_payment_intent_decision_state.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (const sql of [proposalBackfill, paymentIntentBackfill]) {
      expect(sql).toContain("action = 'proposal.decided'");
      expect(sql).toContain("inputs->>'decision'");
      expect(sql).toContain("decision_audit_id");
      expect(sql).toContain("decided_at");
    }
  });
});

function fakePool(sql: string[]): Pool {
  let tenant: string | null = null;
  const client = {
    query: async (statement: string, values: unknown[] = []) => {
      sql.push(statement);
      if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (statement.startsWith("SELECT set_config")) {
        tenant = values[0] as string;
        return { rows: [], rowCount: 1 };
      }
      if (tenant !== TENANT) throw new Error("tenant scope was not set");
      if (statement.includes("FROM proposals")) {
        return {
          rows: [
            {
              proposal_id: PROPOSAL,
              status: "pending",
              decision: null,
              decision_audit_id: null,
              decided_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (statement.includes("FROM ledger_payment_intents")) {
        return {
          rows: [
            {
              proposal_id: PAYMENT_INTENT,
              status: "approved",
              decision: "approve",
              decision_audit_id: AUDIT,
              decided_at: new Date("2026-09-13T08:00:00.000Z"),
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${statement}`);
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}
