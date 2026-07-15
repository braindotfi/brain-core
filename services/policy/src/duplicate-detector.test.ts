import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import { detectDuplicates } from "./duplicate-detector.js";
import type { DuplicateCheckInput } from "./duplicate-detector.js";

// Routes each rule's query (by SQL substring) to a canned result set, so we can
// exercise the collision logic without Postgres. The real SQL/schema is verified
// in a pg environment (see the module's SANDBOX NOTE).
function fakeClient(hits: Record<string, unknown[]>): TenantScopedClient {
  return {
    query: vi.fn(async (text: string) => {
      const key = text.includes("ledger_reconciliation_matches")
        ? "obligation_duplicate_graph"
        : text.includes("FROM ledger_obligations")
          ? "obligation_status"
          : text.includes("invoice_id = $1")
            ? "invoice_already_paid"
            : text.includes("obligation_id = $1")
              ? "obligation_executed"
              : text.includes("interval '30 days'")
                ? "vendor_30d"
                : text.includes("interval '10 minutes'")
                  ? "recent_10m"
                  : text.includes("evidence_ids &&")
                    ? "raw_used"
                    : text.includes("ledger_counterparty_payment_instructions")
                      ? "dest_changed"
                      : "other";
      const rows = hits[key] ?? [];
      return { rows, rowCount: rows.length };
    }),
  } as unknown as TenantScopedClient;
}

function input(over: Partial<DuplicateCheckInput["paymentIntent"]> = {}): DuplicateCheckInput {
  return {
    tenantId: "tnt_x",
    paymentIntent: {
      id: "pi_NEW",
      counterpartyId: "cp_acme",
      amount: "1000.00",
      currency: "USD",
      invoiceId: "INV-1",
      obligationId: "obl_1",
      evidenceArtifactIds: ["raw_1"],
      ...over,
    },
  };
}

describe("detectDuplicates", () => {
  it("passes when no rule finds a collision", async () => {
    const r = await detectDuplicates(fakeClient({}), input());
    expect(r).toEqual({ passed: true, collisions: [] });
  });

  it("flags invoice_already_paid when an executed PI references the invoice", async () => {
    const r = await detectDuplicates(
      fakeClient({ invoice_already_paid: [{ id: "pi_OLD" }] }),
      input(),
    );
    expect(r.passed).toBe(false);
    const c = r.collisions.find((x) => x.rule === "invoice_already_paid");
    expect(c?.conflicting_payment_intent_id).toBe("pi_OLD");
  });

  it("flags obligation_already_settled when the obligation row is paid", async () => {
    const r = await detectDuplicates(
      fakeClient({ obligation_status: [{ status: "paid" }] }),
      input(),
    );
    expect(r.collisions.map((c) => c.rule)).toContain("obligation_already_settled");
  });

  it("rejects payment of a reconciliation-linked duplicate obligation after its peer executed", async () => {
    const r = await detectDuplicates(
      fakeClient({
        obligation_duplicate_graph: [
          {
            obligation_id: "obl_peer",
            payment_intent_id: "pi_ALREADY_EXECUTED",
            status: "due",
          },
        ],
      }),
      input({
        id: "pi_SECOND",
        obligationId: "obl_second",
        counterpartyId: "cp_qbo_acme",
      }),
    );

    expect(r.passed).toBe(false);
    expect(r.collisions).toContainEqual(
      expect.objectContaining({
        rule: "reconciliation_obligation_duplicate_paid",
        conflicting_payment_intent_id: "pi_ALREADY_EXECUTED",
      }),
    );
  });

  it("flags payment_intent_recently_executed inside the 10-minute window", async () => {
    const r = await detectDuplicates(fakeClient({ recent_10m: [{ id: "pi_RETRY" }] }), input());
    expect(r.collisions.map((c) => c.rule)).toContain("payment_intent_recently_executed");
  });

  it("flags raw_invoice_used_elsewhere when the artifact is reused", async () => {
    const r = await detectDuplicates(fakeClient({ raw_used: [{ id: "pi_DUP" }] }), input());
    expect(r.collisions.map((c) => c.rule)).toContain("raw_invoice_used_elsewhere");
  });

  it("flags destination_recently_changed (vendor account swap)", async () => {
    const r = await detectDuplicates(
      fakeClient({ dest_changed: [{ changed_at: new Date() }] }),
      input(),
    );
    expect(r.collisions.map((c) => c.rule)).toContain("destination_recently_changed");
  });

  it("returns ALL collisions when several rules fire", async () => {
    const r = await detectDuplicates(
      fakeClient({
        invoice_already_paid: [{ id: "pi_OLD" }],
        dest_changed: [{ changed_at: new Date() }],
      }),
      input(),
    );
    expect(r.passed).toBe(false);
    expect(r.collisions.map((c) => c.rule)).toEqual(
      expect.arrayContaining(["invoice_already_paid", "destination_recently_changed"]),
    );
  });

  // Adversarial invariant: "Brain will not pay an invoice twice." Sequential
  // simulation of the race resolution — once PI-A executes for an invoice, a
  // second PI-B for the same invoice must be rejected. (The true OS-concurrent
  // two-evaluations-at-once / RLS version is a Postgres integration test —
  // blocked in this sandbox; see the summary.)
  it("rejects a second payment for an invoice once the first has executed", async () => {
    const executedInvoices = new Set<string>();
    const statefulClient: TenantScopedClient = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        if (text.includes("invoice_id = $1")) {
          const invoiceId = String(values?.[0]);
          const rows = executedInvoices.has(invoiceId) ? [{ id: "pi_FIRST" }] : [];
          return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as TenantScopedClient;

    const first = await detectDuplicates(statefulClient, input({ id: "pi_A" }));
    expect(first.passed).toBe(true); // first payment is clear
    executedInvoices.add("INV-1"); // ... and then executes

    const second = await detectDuplicates(statefulClient, input({ id: "pi_B" }));
    expect(second.passed).toBe(false);
    expect(second.collisions.map((c) => c.rule)).toContain("invoice_already_paid");
  });

  it("skips invoice/obligation rules when those ids are absent", async () => {
    const noIds: DuplicateCheckInput = {
      tenantId: "tnt_x",
      paymentIntent: {
        id: "pi_NEW",
        counterpartyId: "cp_acme",
        amount: "1000.00",
        currency: "USD",
        evidenceArtifactIds: [],
      },
    };
    const r = await detectDuplicates(fakeClient({}), noIds);
    expect(r.passed).toBe(true);
  });
});
