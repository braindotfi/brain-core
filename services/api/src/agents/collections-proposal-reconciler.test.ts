import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  InMemoryAuditEmitter,
  MockMetrics,
  newCounterpartyId,
  newInvoiceId,
  newProposalId,
  newTenantId,
} from "@brain/shared";
import type { AgentServiceDeps } from "@brain/execution";
import { runCollectionsProposalReconcileCycle } from "./collections-proposal-reconciler.js";

interface FakeProposal {
  id: string;
  tenant_id: string;
  proposing_agent: string;
  action: Record<string, unknown>;
  policy_version: number;
  policy_decision: string;
  policy_trace: unknown[];
  required_approvers: string[];
  status: string;
  approvers_signed: string[];
  proposal_dedup_key: string | null;
  created_at: Date;
  updated_at: Date;
  superseded_at: Date | null;
}

interface FakeInvoice {
  id: string;
  owner_id: string;
  status: string;
  amount_due: number;
  amount_paid: number;
  due_date: string | null;
}

const CONFIRM_POLICY: AgentServiceDeps["evaluatePolicy"] = async () => ({
  outcome: "confirm",
  matched_rule_id: "test_confirm",
  required_approvers: [],
  trace: [],
  policy_version: 2,
});

describe("runCollectionsProposalReconcileCycle", () => {
  it("supersedes a pending proposal whose invoice row is absent exactly once, and a second cycle is a no-op", async () => {
    const tenantId = newTenantId();
    const invoiceId = newInvoiceId();
    const proposal = collectionsProposal({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      days_overdue: 20,
    });
    const { appPool, tenantDiscoveryPool, proposals } = fakeDb([proposal], []);
    const audit = new InMemoryAuditEmitter();
    const metrics = new MockMetrics();

    await runCollectionsProposalReconcileCycle({
      tenantDiscoveryPool,
      appPool,
      evaluatePolicy: CONFIRM_POLICY,
      audit,
      metrics,
    });

    expect(proposals[0]?.status).toBe("superseded");
    expect(proposals[0]?.superseded_at).not.toBeNull();
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      tenantId,
      action: "agent.action.superseded",
      outputs: { status: "superseded", reason: "source_invoice_missing" },
    });
    expect(
      metrics.calls.some((call) => call.name === "brain.collections.reconcile.superseded.count"),
    ).toBe(true);

    // Second cycle: the proposal is no longer pending, so it drops out of
    // the candidate set entirely. No further write, no further audit event.
    await runCollectionsProposalReconcileCycle({
      tenantDiscoveryPool,
      appPool,
      evaluatePolicy: CONFIRM_POLICY,
      audit,
      metrics,
    });
    expect(audit.events).toHaveLength(1);
    expect(proposals[0]?.status).toBe("superseded");
  });

  it("refreshes a pending proposal with drifted days_overdue in place, preserving evidence and identity", async () => {
    const tenantId = newTenantId();
    const invoiceId = newInvoiceId();
    const counterpartyId = newCounterpartyId();
    const proposal = collectionsProposal({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      counterparty_id: counterpartyId,
      days_overdue: 10,
      aging_tier: "1_14",
      recommended_action: "draft_followup",
    });
    const proposalId = proposal.id;
    const invoice: FakeInvoice = {
      id: invoiceId,
      owner_id: tenantId,
      status: "sent",
      amount_due: 900,
      amount_paid: 0,
      due_date: "2026-06-01T00:00:00.000Z",
    };
    const { appPool, tenantDiscoveryPool, proposals } = fakeDb([proposal], [invoice]);
    const audit = new InMemoryAuditEmitter();

    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool, appPool, evaluatePolicy: CONFIRM_POLICY, audit },
      { now: new Date("2026-07-20T00:00:00.000Z") },
    );

    const refreshedRow = proposals.find((p) => p.id === proposalId);
    expect(refreshedRow?.id).toBe(proposalId);
    expect(refreshedRow?.status).toBe("pending");
    expect(refreshedRow?.action).toMatchObject({
      days_overdue: 49,
      aging_tier: "30_59",
      recommended_action: "escalate",
      escalation_tier: "escalation",
      confidence: 0.8,
      evidence_score: 0.8,
      invoice_id: invoiceId,
      counterparty_id: counterpartyId,
    });
    expect(refreshedRow?.policy_version).toBe(2);
    expect(refreshedRow?.policy_decision).toBe("confirm");

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      tenantId,
      action: "agent.action.refreshed",
      outputs: { previous_days_overdue: 10, days_overdue: 49 },
    });
  });

  it("leaves an already-current pending proposal completely untouched", async () => {
    const tenantId = newTenantId();
    const invoiceId = newInvoiceId();
    const proposal = collectionsProposal({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      days_overdue: 19,
    });
    const invoice: FakeInvoice = {
      id: invoiceId,
      owner_id: tenantId,
      status: "sent",
      amount_due: 900,
      amount_paid: 0,
      due_date: "2026-07-01T00:00:00.000Z",
    };
    const { appPool, tenantDiscoveryPool, proposals } = fakeDb([proposal], [invoice]);
    const audit = new InMemoryAuditEmitter();
    const before = { ...proposal, action: { ...proposal.action } };

    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool, appPool, evaluatePolicy: CONFIRM_POLICY, audit },
      { now: new Date("2026-07-20T00:00:00.000Z") },
    );

    expect(proposals[0]).toMatchObject({ status: before.status, action: before.action });
    expect(audit.events).toHaveLength(0);
  });

  it("never touches a non-pending collections proposal", async () => {
    const tenantId = newTenantId();
    const invoiceId = newInvoiceId();
    const proposal = collectionsProposal({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      days_overdue: 5,
      status: "approved",
    });
    // No matching invoice row: if this proposal were reconciled it would be
    // superseded. It must not be, because it is not pending.
    const { appPool, tenantDiscoveryPool, proposals } = fakeDb([proposal], []);
    const audit = new InMemoryAuditEmitter();

    await runCollectionsProposalReconcileCycle({
      tenantDiscoveryPool,
      appPool,
      evaluatePolicy: CONFIRM_POLICY,
      audit,
    });

    expect(proposals[0]?.status).toBe("approved");
    expect(audit.events).toHaveLength(0);
  });

  it("keeps tenants isolated: one tenant's missing-invoice supersede never touches another tenant's row", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    const invoiceA = newInvoiceId();
    const invoiceB = newInvoiceId();
    const proposalA = collectionsProposal({
      tenant_id: tenantA,
      invoice_id: invoiceA,
      days_overdue: 20,
    });
    const proposalB = collectionsProposal({
      tenant_id: tenantB,
      invoice_id: invoiceB,
      days_overdue: 19,
    });
    const invoiceRowB: FakeInvoice = {
      id: invoiceB,
      owner_id: tenantB,
      status: "sent",
      amount_due: 900,
      amount_paid: 0,
      due_date: "2026-07-01T00:00:00.000Z",
    };
    const { appPool, tenantDiscoveryPool, proposals } = fakeDb(
      [proposalA, proposalB],
      [invoiceRowB],
    );
    const audit = new InMemoryAuditEmitter();

    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool, appPool, evaluatePolicy: CONFIRM_POLICY, audit },
      { now: new Date("2026-07-20T00:00:00.000Z") },
    );

    const rowA = proposals.find((p) => p.tenant_id === tenantA);
    const rowB = proposals.find((p) => p.tenant_id === tenantB);
    expect(rowA?.status).toBe("superseded");
    expect(rowB?.status).toBe("pending");
    expect(rowB?.action).toEqual(proposalB.action);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.tenantId).toBe(tenantA);
  });

  it("reconciles rows that need work even when far more than one batch's worth of already-current rows sit ahead of them in created_at order", async () => {
    // Regression for the scan-window starvation bug: the work list is
    // filtered in SQL, so `current` rows never occupy a batch slot at all,
    // regardless of how they sort by created_at.
    const tenantId = newTenantId();
    const baseCreatedAt = new Date("2026-01-01T00:00:00.000Z");

    const currentProposals: FakeProposal[] = [];
    const currentInvoices: FakeInvoice[] = [];
    for (let i = 0; i < 60; i += 1) {
      const invoiceId = newInvoiceId();
      const createdAt = new Date(baseCreatedAt.getTime() + i * 60_000);
      currentProposals.push(
        collectionsProposal(
          { tenant_id: tenantId, invoice_id: invoiceId, days_overdue: 19 },
          { created_at: createdAt, updated_at: createdAt },
        ),
      );
      currentInvoices.push({
        id: invoiceId,
        owner_id: tenantId,
        status: "sent",
        amount_due: 900,
        amount_paid: 0,
        due_date: "2026-07-01T00:00:00.000Z",
      });
    }

    const needsWorkProposals = [newInvoiceId(), newInvoiceId()].map((invoiceId, i) =>
      collectionsProposal(
        { tenant_id: tenantId, invoice_id: invoiceId, days_overdue: 20 },
        {
          created_at: new Date(baseCreatedAt.getTime() + (61 + i) * 60_000),
          updated_at: new Date(baseCreatedAt.getTime() + (61 + i) * 60_000),
        },
      ),
    );

    const { appPool, tenantDiscoveryPool, proposals } = fakeDb(
      [...currentProposals, ...needsWorkProposals],
      currentInvoices,
    );
    const audit = new InMemoryAuditEmitter();

    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool, appPool, evaluatePolicy: CONFIRM_POLICY, audit },
      { now: new Date("2026-07-20T00:00:00.000Z") },
    );

    for (const p of needsWorkProposals) {
      expect(proposals.find((r) => r.id === p.id)?.status).toBe("superseded");
    }
    for (const p of currentProposals) {
      expect(proposals.find((r) => r.id === p.id)?.status).toBe("pending");
    }
    expect(audit.events).toHaveLength(2);
  });

  it("treats an invoice whose due date moved into the future as non_collectible instead of refreshing it to a fabricated 1 day overdue", async () => {
    const tenantId = newTenantId();
    const invoiceId = newInvoiceId();
    const proposal = collectionsProposal({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      days_overdue: 10,
    });
    const invoice: FakeInvoice = {
      id: invoiceId,
      owner_id: tenantId,
      status: "sent",
      amount_due: 900,
      amount_paid: 0,
      // Corrected or renegotiated term: now in the future relative to `now`.
      due_date: "2026-08-01T00:00:00.000Z",
    };
    const { appPool, tenantDiscoveryPool, proposals } = fakeDb([proposal], [invoice]);
    const audit = new InMemoryAuditEmitter();
    const before = { ...proposal, action: { ...proposal.action } };

    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool, appPool, evaluatePolicy: CONFIRM_POLICY, audit },
      { now: new Date("2026-07-20T00:00:00.000Z") },
    );

    expect(proposals[0]).toMatchObject({ status: before.status, action: before.action });
    expect(audit.events).toHaveLength(0);
  });

  it("warns and reports a dropped count when a tenant's work list exceeds the per-tenant batch cap", async () => {
    const tenantId = newTenantId();
    const invoiceIds = [newInvoiceId(), newInvoiceId(), newInvoiceId()];
    const proposals = invoiceIds.map((invoiceId, i) =>
      collectionsProposal({ tenant_id: tenantId, invoice_id: invoiceId, days_overdue: 20 + i }),
    );
    // No matching invoices: every one of these needs a supersede, so all
    // three match the work-list filter regardless of ordering.
    const { appPool, tenantDiscoveryPool } = fakeDb(proposals, []);
    const metrics = new MockMetrics();
    const warn = vi.fn();

    await runCollectionsProposalReconcileCycle(
      {
        tenantDiscoveryPool,
        appPool,
        evaluatePolicy: CONFIRM_POLICY,
        metrics,
        log: { error: vi.fn(), warn },
      },
      { now: new Date("2026-07-20T00:00:00.000Z"), perTenantBatchSize: 2 },
    );

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, totalMatching: 3, omittedCount: 1 }),
      "collections proposal reconciler hit per-tenant batch cap",
    );
    expect(
      metrics.calls.some(
        (call) =>
          call.name === "brain.collections.reconcile.dropped.count" &&
          call.tags?.reason === "batch_cap",
      ),
    ).toBe(true);
  });

  it("touches only updated_at, not action or status, when a refresh would leave a proposal out of pending, so it rotates to the back of the work list", async () => {
    const tenantId = newTenantId();
    const invoiceId = newInvoiceId();
    const proposal = collectionsProposal({
      tenant_id: tenantId,
      invoice_id: invoiceId,
      days_overdue: 10,
    });
    const invoice: FakeInvoice = {
      id: invoiceId,
      owner_id: tenantId,
      status: "sent",
      amount_due: 900,
      amount_paid: 0,
      due_date: "2026-06-01T00:00:00.000Z",
    };
    const { appPool, tenantDiscoveryPool, proposals } = fakeDb([proposal], [invoice]);
    const before = { ...proposal, action: { ...proposal.action }, updated_at: proposal.updated_at };
    const allowPolicy: AgentServiceDeps["evaluatePolicy"] = async () => ({
      outcome: "allow",
      matched_rule_id: "test_allow",
      required_approvers: [],
      trace: [],
      policy_version: 3,
    });

    await runCollectionsProposalReconcileCycle(
      { tenantDiscoveryPool, appPool, evaluatePolicy: allowPolicy },
      { now: new Date("2026-07-20T00:00:00.000Z") },
    );

    const row = proposals.find((p) => p.id === proposal.id);
    expect(row?.status).toBe("pending");
    expect(row?.action).toEqual(before.action);
    expect(row?.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});

function collectionsProposal(
  input: {
    tenant_id: string;
    invoice_id: string;
    days_overdue: number;
    counterparty_id?: string;
    aging_tier?: string;
    recommended_action?: string;
    status?: string;
  },
  overrides: Partial<FakeProposal> = {},
): FakeProposal {
  const counterpartyId = input.counterparty_id ?? newCounterpartyId();
  return {
    id: newProposalId(),
    tenant_id: input.tenant_id,
    proposing_agent: "collections",
    action: {
      type: "collections",
      kind: "agent_action",
      invoice_id: input.invoice_id,
      counterparty_id: counterpartyId,
      counterparty_name: "Acme",
      invoice_number: "INV-100",
      amount_due: "900.00",
      currency: "USD",
      due_date: "2026-06-01T00:00:00.000Z",
      days_overdue: input.days_overdue,
      aging_tier: input.aging_tier ?? "15_29",
      recommended_action: input.recommended_action ?? "create_task",
      escalation_tier: "task",
      ranked_recommendations: ["create_task", "draft_followup", "escalate", "propose_payment_plan"],
      recommended_tone: "firm",
      draft_message: "Following up: INV-100 for 900.00 USD is overdue.",
      next_escalation_date: "2026-07-25",
      narrative: "Acme has 900.00 USD outstanding.",
      summary: "900.00 USD receivable is overdue for Acme.",
      risk_band: "elevated",
      confidence: 0.8,
      evidence_score: 0.8,
      risk_level: "medium",
      agent_id: "collections",
      agent_role: "collections",
      evidence_refs: [{ kind: "invoice", ref: input.invoice_id }],
      missing_required_evidence: [],
      critical_missing: false,
      mode: "propose",
    },
    policy_version: 1,
    policy_decision: "confirm",
    policy_trace: [],
    required_approvers: [],
    status: input.status ?? "pending",
    approvers_signed: [],
    proposal_dedup_key: null,
    created_at: new Date("2026-07-01T00:00:00.000Z"),
    updated_at: new Date("2026-07-01T00:00:00.000Z"),
    superseded_at: null,
    ...overrides,
  };
}

/** Minimal in-memory Postgres fake covering exactly the query shapes the
 *  reconciler and the repository primitives it reuses issue. Pattern-matches
 *  on stable SQL substrings, mirroring collections-overdue-scanner.test.ts's
 *  cooldownPool()/scanPoolWith() fakes. */
function fakeDb(
  proposals: FakeProposal[],
  invoices: FakeInvoice[],
): { appPool: Pool; tenantDiscoveryPool: Pool; proposals: FakeProposal[] } {
  const appPool = {
    connect: async () => {
      let tenantId: string | null = null;
      return {
        query: vi.fn(async (text: string, values: unknown[] = []) => {
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
            return { rows: [], rowCount: 0 };
          }
          if (text.startsWith("SELECT set_config")) {
            tenantId = String(values[0]);
            return { rows: [], rowCount: 0 };
          }
          if (text.includes("pg_advisory_xact_lock")) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes("LEFT JOIN ledger_invoices")) {
            // Work list: only rows that actually need action (invoice
            // missing, or collectible + overdue + drifted days_overdue).
            const limit = Number(values[0]);
            const now = new Date(String(values[1]));
            const matching = proposals
              .filter((p) => p.tenant_id === tenantId && isPendingCollections(p))
              .filter((p) => {
                const invoiceId = p.action["invoice_id"];
                const inv = invoices.find((i) => i.id === invoiceId && i.owner_id === tenantId);
                return needsCollectionsWork(p.action, inv, now);
              })
              .sort((a, b) => {
                const byUpdatedAt = a.updated_at.getTime() - b.updated_at.getTime();
                return byUpdatedAt !== 0 ? byUpdatedAt : a.id.localeCompare(b.id);
              });
            const totalMatching = matching.length;
            const rows = matching.slice(0, limit).map((p) => ({
              invoice_id: p.action["invoice_id"] as string,
              total_matching: totalMatching,
            }));
            return { rows, rowCount: rows.length };
          }
          if (text.includes("JOIN ledger_invoices")) {
            // Non-collectible aggregate: invoice exists but isn't actionable.
            const now = new Date(String(values[0]));
            const count = proposals
              .filter((p) => p.tenant_id === tenantId && isPendingCollections(p))
              .filter((p) => {
                const inv = invoices.find(
                  (i) => i.id === p.action["invoice_id"] && i.owner_id === tenantId,
                );
                return inv !== undefined && isNonCollectibleInvoice(inv, now);
              }).length;
            return { rows: [{ count }], rowCount: 1 };
          }
          if (text.includes("SET updated_at = $2 WHERE id = $1")) {
            const id = String(values[0]);
            const row = proposals.find((p) => p.id === id && p.status === "pending");
            if (row === undefined) return { rows: [], rowCount: 0 };
            row.updated_at = new Date(String(values[1]));
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes("FOR UPDATE")) {
            const invoiceId = String(values[0]);
            const matches = proposals
              .filter(
                (p) =>
                  p.tenant_id === tenantId &&
                  isPendingCollections(p) &&
                  p.action["invoice_id"] === invoiceId,
              )
              .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
            const row = matches[0];
            return row !== undefined ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          if (text.includes("FROM ledger_invoices")) {
            const invoiceId = String(values[0]);
            const now = new Date(String(values[1]));
            const inv = invoices.find((i) => i.id === invoiceId && i.owner_id === tenantId);
            if (inv === undefined) return { rows: [], rowCount: 0 };
            const isOverdue =
              inv.due_date !== null && new Date(inv.due_date).getTime() < now.getTime();
            const calculated = isOverdue
              ? Math.max(
                  Math.floor(
                    (now.getTime() - new Date(inv.due_date as string).getTime()) / 86_400_000,
                  ),
                  1,
                )
              : null;
            return {
              rows: [
                {
                  status: inv.status,
                  collectible_by_amount: inv.amount_paid < inv.amount_due,
                  due_date: inv.due_date,
                  calculated_days_overdue: calculated,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes("SET action = $2")) {
            const id = String(values[0]);
            const row = proposals.find((p) => p.id === id && p.status === "pending");
            if (row === undefined) return { rows: [], rowCount: 0 };
            row.action = JSON.parse(String(values[1])) as Record<string, unknown>;
            row.policy_version = Number(values[2]);
            row.policy_decision = String(values[3]);
            row.policy_trace = JSON.parse(String(values[4])) as unknown[];
            row.required_approvers = values[5] as string[];
            row.status = String(values[6]);
            row.updated_at = new Date();
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes("status = 'superseded'")) {
            const id = String(values[0]);
            const row = proposals.find((p) => p.id === id && p.status === "pending");
            if (row === undefined) return { rows: [], rowCount: 0 };
            row.status = "superseded";
            row.superseded_at = new Date(String(values[1]));
            row.updated_at = new Date(String(values[1]));
            return { rows: [row], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
      };
    },
  } as unknown as Pool;

  const tenantDiscoveryPool = {
    query: vi.fn(async (_text: string, values: unknown[] = []) => {
      const limit = Number(values[0]);
      const ids = Array.from(
        new Set(proposals.filter((p) => isPendingCollections(p)).map((p) => p.tenant_id)),
      )
        .sort()
        .slice(0, limit);
      return { rows: ids.map((tenant_id) => ({ tenant_id })), rowCount: ids.length };
    }),
  } as unknown as Pool;

  return { appPool, tenantDiscoveryPool, proposals };
}

function isPendingCollections(p: FakeProposal): boolean {
  return (
    p.proposing_agent === "collections" &&
    p.status === "pending" &&
    p.action["type"] === "collections" &&
    typeof p.action["invoice_id"] === "string" &&
    p.action["invoice_id"] !== ""
  );
}

const NON_COLLECTIBLE_STATUSES = new Set(["paid", "cancelled", "disputed"]);

function isNonCollectibleInvoice(inv: FakeInvoice, now: Date): boolean {
  if (NON_COLLECTIBLE_STATUSES.has(inv.status)) return true;
  if (inv.amount_paid >= inv.amount_due) return true;
  if (inv.due_date !== null && new Date(inv.due_date).getTime() >= now.getTime()) return true;
  return false;
}

/** Mirrors the reconciler's work-list SQL: needs action only when the
 *  invoice is missing, or is collectible, overdue, and drifted. */
function needsCollectionsWork(
  action: Record<string, unknown>,
  inv: FakeInvoice | undefined,
  now: Date,
): boolean {
  if (inv === undefined) return true;
  if (isNonCollectibleInvoice(inv, now)) return false;
  if (inv.due_date === null) return false;
  const computed = Math.max(
    Math.floor((now.getTime() - new Date(inv.due_date).getTime()) / 86_400_000),
    1,
  );
  return action["days_overdue"] !== computed;
}
