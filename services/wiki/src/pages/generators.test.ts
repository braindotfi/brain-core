import { describe, expect, it, vi } from "vitest";
import type { ServiceCallContext, TenantScopedClient } from "@brain/shared";
import { PolicyPageGenerator } from "./policy.js";
import { AgentPageGenerator } from "./agent.js";
import { InvoicePageGenerator } from "./invoice.js";
import type { AgentView, PolicyReader, PolicyView, AgentReader } from "./types.js";

const ctx: ServiceCallContext = { tenantId: "tnt_test", actor: "user_test", requestId: "req_1" };

// A client that fails any query — proves the policy generator does NOT touch
// the DB and the agent generator only uses it for the sanctioned ledger read.
function noDbClient(): TenantScopedClient {
  return {
    query: vi.fn(async () => {
      throw new Error("policy/agent generators must not query the DB directly");
    }),
  } as unknown as TenantScopedClient;
}

function ledgerOnlyClient(): TenantScopedClient {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("ledger_payment_intents")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected direct query: ${text.slice(0, 40)}`);
    }),
  } as unknown as TenantScopedClient;
}

describe("PolicyPageGenerator", () => {
  const policy: PolicyView = {
    id: "pol_1",
    version: 3,
    state: "active",
    quorum_required: 2,
    signers: [{ address: "0xabc" }],
    activated_at: new Date("2026-05-01T00:00:00Z"),
    deactivated_at: null,
    created_by: "user_root",
    created_at: new Date("2026-04-01T00:00:00Z"),
  };

  it("renders an active policy from the policy reader (no direct DB)", async () => {
    const reader: PolicyReader = { byId: async () => null, active: async () => policy };
    const gen = new PolicyPageGenerator();
    const out = await gen.render(
      { ctx, client: noDbClient(), policyReader: reader },
      { subjectId: null, slug: "/policies/active" },
    );
    expect(out.body_md).toContain("Policy v3");
    expect(out.body_md).toContain("active");
    expect(out.subject_id).toBe("pol_1");
  });

  it("renders the no-policy page when the reader returns null", async () => {
    const reader: PolicyReader = { byId: async () => null, active: async () => null };
    const gen = new PolicyPageGenerator();
    const out = await gen.render(
      { ctx, client: noDbClient(), policyReader: reader },
      { subjectId: null, slug: "/policies/active" },
    );
    expect(out.body_md).toContain("No active policy");
  });
});

describe("AgentPageGenerator", () => {
  const agent: AgentView = {
    id: "agent_1",
    kind: "treasury",
    role: "payer",
    display_name: "Treasury Bot",
    onchain_address: "0xdef",
    state: "active",
    registered_at: new Date("2026-05-01T00:00:00Z"),
    created_at: new Date("2026-04-01T00:00:00Z"),
  };

  it("renders an agent from the agent reader; payment intents via the sanctioned ledger read", async () => {
    const reader: AgentReader = { byId: async () => agent };
    const gen = new AgentPageGenerator();
    const out = await gen.render(
      { ctx, client: ledgerOnlyClient(), agentReader: reader },
      { subjectId: "agent_1", slug: "/agents/agent_1" },
    );
    expect(out.body_md).toContain("Treasury Bot");
    expect(out.subject_id).toBe("agent_1");
  });
});

describe("InvoicePageGenerator", () => {
  it("renders /invoices/all as an empty state when no ledger invoices exist", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("COUNT(*)::TEXT AS invoice_count")) {
          return {
            rows: [
              {
                invoice_count: "0",
                overdue_count: "0",
                open_amount: "0",
                paid_amount: "0",
                currency: null,
              },
            ],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected query: ${text}`);
      }),
    } as unknown as TenantScopedClient;

    const gen = new InvoicePageGenerator();
    const resolved = gen.resolveSlug("/invoices/all");
    expect(resolved).toEqual({ subjectId: null, slug: "/invoices/all" });

    const out = await gen.render({ ctx, client }, resolved!);

    expect(out.slug).toBe("/invoices/all");
    expect(out.subject_id).toBeNull();
    expect(out.body_md).toContain("Invoice count: 0");
    expect(out.body_md).toContain("No invoice rows are anchored in Ledger yet");
    expect(out.source_revision).toBe("invoices_all_empty");
    expect(queries.some((q) => q.includes("WHERE id = $1 LIMIT 1"))).toBe(false);
    expect(queries.some((q) => q.includes("ORDER BY updated_at DESC"))).toBe(false);
  });

  it("renders recent invoices for /invoices/all when invoice rows exist", async () => {
    const updatedAt = new Date("2026-06-30T12:00:00Z");
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("COUNT(*)::TEXT AS invoice_count")) {
          return {
            rows: [
              {
                invoice_count: "1",
                overdue_count: "1",
                open_amount: "1200.00",
                paid_amount: "300.00",
                currency: "USD",
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("FROM ledger_invoices") && text.includes("ORDER BY updated_at DESC")) {
          return {
            rows: [
              {
                id: "inv_1",
                invoice_number: "NL-2417",
                counterparty_id: "cp_1",
                amount_due: "1500.00",
                amount_paid: "300.00",
                currency: "USD",
                issue_date: new Date("2026-05-01T00:00:00Z"),
                due_date: new Date("2026-05-22T00:00:00Z"),
                status: "overdue",
                linked_document_ids: [],
                linked_transaction_ids: [],
                source_ids: [],
                evidence_ids: [],
                updated_at: updatedAt,
              },
            ],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected query: ${text}`);
      }),
    } as unknown as TenantScopedClient;

    const gen = new InvoicePageGenerator();
    const out = await gen.render({ ctx, client }, { subjectId: null, slug: "/invoices/all" });

    expect(out.body_md).toContain("Invoice count: 1");
    expect(out.body_md).toContain("NL-2417");
    expect(out.body_md).toContain("1 overdue invoice(s) require review");
    expect(out.source_revision).toMatch(/^[a-f0-9]{16}$/);
    expect(out.source_revision).not.toBe("invoices_all_empty");
  });

  it("renders an invoice page when its counterparty row is missing", async () => {
    const updatedAt = new Date("2026-06-30T12:00:00Z");
    const client = {
      query: vi.fn(async (text: string) => {
        if (text.includes("FROM ledger_invoices WHERE id = $1 LIMIT 1")) {
          return {
            rows: [
              {
                id: "inv_1",
                invoice_number: "NL-2417",
                counterparty_id: "cp_missing",
                amount_due: "1500.00",
                amount_paid: "0.00",
                currency: "USD",
                issue_date: new Date("2026-05-01T00:00:00Z"),
                due_date: new Date("2026-05-22T00:00:00Z"),
                status: "overdue",
                linked_document_ids: [],
                linked_transaction_ids: [],
                source_ids: [],
                evidence_ids: [],
                updated_at: updatedAt,
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("FROM ledger_counterparties WHERE id = $1 LIMIT 1")) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected query: ${text}`);
      }),
    } as unknown as TenantScopedClient;

    const gen = new InvoicePageGenerator();
    const out = await gen.render({ ctx, client }, { subjectId: "inv_1", slug: "/invoices/inv_1" });

    expect(out.body_md).toContain("`cp_missing` (missing)");
    expect(out.body_md).toContain("No linked entities");
    expect(out.body_md).toContain("Overdue invoice");
  });
});
