/**
 * Tests for seedBrainSaasDemo — the BrainSaaS demo seeder.
 *
 * The seeder writes through the v0.3 ledger write helpers (mocked here) and
 * raw tenant-scoped SQL via `withTenantScope` (mocked to invoke its callback
 * with a recording fake client). No real Postgres is required: the helpers
 * return canned rows keyed off the input name, and the fake tenant-scoped
 * client routes SQL by substring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate, type Action, type PolicyDocument } from "@brain/policy";
import type * as BrainShared from "@brain/shared";

const { upsertCounterpartyRow, upsertAccountRow, recordTransactionRow } = vi.hoisted(() => ({
  upsertCounterpartyRow: vi.fn(),
  upsertAccountRow: vi.fn(),
  recordTransactionRow: vi.fn(),
}));

vi.mock("@brain/ledger", () => ({
  upsertCounterpartyRow,
  upsertAccountRow,
  recordTransactionRow,
}));

// Record of every tenant-scoped SQL statement executed, so we can assert on the
// raw INSERT/UPDATE side of the seeder without a real database.
const { scopedCalls } = vi.hoisted(() => ({
  scopedCalls: [] as { sql: string; values: unknown[] | undefined }[],
}));

vi.mock("@brain/shared", async () => {
  const actual = await vi.importActual<typeof BrainShared>("@brain/shared");
  return {
    ...actual,
    withTenantScope: vi.fn(
      async (
        _pool: unknown,
        _tenantId: string,
        fn: (c: {
          query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
        }) => Promise<unknown>,
      ) => {
        const client = {
          query: async (sql: string, values?: unknown[]) => {
            scopedCalls.push({ sql, values });
            if (sql.includes("COALESCE(MAX(version)")) {
              return { rows: [{ next: 1 }] };
            }
            return { rows: [] };
          },
        };
        return fn(client);
      },
    ),
  };
});

import { InMemoryAuditEmitter, newTenantId, newUserId } from "@brain/shared";
import type { Pool } from "pg";
import { seedBrainSaasDemo } from "./brainsaas-seed.js";

const TENANT = newTenantId();
const ACTOR = newUserId();

beforeEach(() => {
  scopedCalls.length = 0;
  upsertCounterpartyRow.mockImplementation(
    async (
      _pool: unknown,
      _audit: unknown,
      _ctx: unknown,
      args: { name: string; type: string },
    ) => ({
      row: { id: `cp_${args.type}_${args.name.replace(/\W+/g, "_")}` },
      created: true,
    }),
  );
  upsertAccountRow.mockImplementation(
    async (
      _pool: unknown,
      _audit: unknown,
      _ctx: unknown,
      args: { external_account_id: string },
    ) => ({
      row: { id: `acct_${args.external_account_id}` },
      created: true,
    }),
  );
  recordTransactionRow.mockResolvedValue({ row: { id: "tx_seed" }, created: true });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env["BRAIN_ONCHAIN_SMART_ACCOUNT"];
  delete process.env["BRAIN_DEMO_ONCHAIN_RECIPIENT"];
  delete process.env["BRAIN_AGENTS_INBOUND_SECRET"];
});

function deps(): { pool: Pool; audit: InMemoryAuditEmitter } {
  return { pool: {} as Pool, audit: new InMemoryAuditEmitter() };
}

describe("seedBrainSaasDemo", () => {
  it("seeds vendors, customers, accounts, invoices, policy, and agent", async () => {
    const { pool, audit } = deps();
    const result = await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    expect(result.tenantId).toBe(TENANT);
    expect(result.actor).toBe(ACTOR);

    // 6 vendors + 4 customers via the counterparty helper.
    expect(upsertCounterpartyRow).toHaveBeenCalledTimes(10);
    expect(Object.keys(result.vendors)).toEqual([
      "cloudops",
      "stripelike",
      "legal",
      "office",
      "datacenter",
      "quickpay",
    ]);
    expect(Object.keys(result.customers)).toEqual(["bigco", "midmarket", "startupx", "enterprise"]);

    // 2 accounts (operating + reserve); no smart account without the env var.
    expect(upsertAccountRow).toHaveBeenCalledTimes(2);
    expect(result.accounts.smartAccount).toBeNull();
    expect(result.accounts.operating).toBe("acct_brainsaas_operating");
    expect(result.accounts.reserve).toBe("acct_brainsaas_reserve");
    const accountArgs = upsertAccountRow.mock.calls.map((c) => c[3] as { institution: string });
    expect(accountArgs.map((a) => a.institution)).toEqual([
      "First Meridian Bank",
      "First Meridian Bank",
    ]);

    // AP inbox (3) + AR receivables (4).
    expect(Object.keys(result.apInvoices)).toEqual(["cloudops", "datacenter", "quickpay"]);
    expect(Object.keys(result.arInvoices)).toEqual([
      "bigco",
      "midmarket",
      "startupx",
      "enterprise",
    ]);

    expect(result.policyId.startsWith("pol_")).toBe(true);
    expect(result.agentId.startsWith("agent_")).toBe(true);
    expect(Object.keys(result.proposals)).toEqual([
      "midmarket_collections",
      "startupx_collections",
    ]);
    expect(Object.values(result.proposals).every((id) => id.startsWith("prop_"))).toBe(true);
    expect(Object.keys(result.sources)).toEqual([
      "plaid",
      "stripe",
      "finch",
      "merge_accounting",
      "alchemy_wallet",
      "tax_return",
    ]);
  });

  it("does not overwrite tenant kind when seeding an existing durable tenant", async () => {
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const tenantUpsert = scopedCalls.find((c) =>
      c.sql.includes("INSERT INTO tenants (id, kind, default_ap_account_id)"),
    );
    expect(tenantUpsert).toBeDefined();
    expect(tenantUpsert?.sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(tenantUpsert?.sql).toContain("SET default_ap_account_id");
    expect(tenantUpsert?.sql).not.toContain("SET kind");
  });

  it("marks unapproved vendors high-risk with no settlement alias", async () => {
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const quickpayCall = upsertCounterpartyRow.mock.calls.find(
      (c) => (c[3] as { name: string }).name === "Quick Pay Solutions",
    );
    expect(quickpayCall).toBeDefined();
    const args = quickpayCall![3] as {
      risk_level: string;
      verified_status: string;
      aliases: string[];
      metadata: { approved: boolean };
    };
    expect(args.risk_level).toBe("high");
    expect(args.verified_status).toBe("unverified");
    expect(args.aliases).toEqual([]);
    expect(args.metadata.approved).toBe(false);
  });

  it("uses the configured onchain recipient as the approved-vendor alias", async () => {
    process.env["BRAIN_DEMO_ONCHAIN_RECIPIENT"] = "0xABCDEF0000000000000000000000000000000001";
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const cloudops = upsertCounterpartyRow.mock.calls.find(
      (c) => (c[3] as { name: string }).name === "CloudOps Inc",
    );
    const args = cloudops![3] as { aliases: string[] };
    expect(args.aliases).toEqual(["0xABCDEF0000000000000000000000000000000001"]);
  });

  it("seeds an onchain smart account when BRAIN_ONCHAIN_SMART_ACCOUNT is set", async () => {
    process.env["BRAIN_ONCHAIN_SMART_ACCOUNT"] = "0xSMART00000000000000000000000000000000AA";
    const { pool, audit } = deps();
    const result = await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    // 3 accounts now: operating + reserve + smart.
    expect(upsertAccountRow).toHaveBeenCalledTimes(3);
    expect(result.accounts.smartAccount).toBe("acct_0xSMART00000000000000000000000000000000AA");
    const smartAccountCall = upsertAccountRow.mock.calls.find(
      (c) =>
        (c[3] as { external_account_id: string }).external_account_id ===
        "0xSMART00000000000000000000000000000000AA",
    );
    expect(smartAccountCall).toBeDefined();
    expect(smartAccountCall![3]).toMatchObject({
      institution: "Base Sepolia",
      name: "Brightline Treasury Wallet",
    });
  });

  it("posts monthly inflow history only for customers with payment_days", async () => {
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    // bigco has 5 payment_days, enterprise has 5; midmarket + startupx have none.
    expect(recordTransactionRow).toHaveBeenCalledTimes(10);
    const directions = recordTransactionRow.mock.calls.map(
      (c) => (c[3] as { direction: string }).direction,
    );
    expect(directions.every((d) => d === "inflow")).toBe(true);
  });

  it("seeds fake-connected demo sources that overlap with document data", async () => {
    const { pool, audit } = deps();
    const result = await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const deletePrior = scopedCalls.find((c) =>
      c.sql.includes("metadata->>'demo_seed_kind' = 'fake_connected_source'"),
    );
    expect(deletePrior).toBeDefined();

    const inserts = scopedCalls.filter((c) => c.sql.includes("INSERT INTO raw_sources"));
    expect(inserts).toHaveLength(6);
    expect(Object.values(result.sources).every((id) => id.startsWith("src_"))).toBe(true);

    const byType = new Map(
      inserts.map((c) => [
        c.values?.[2],
        {
          externalAccountIds: c.values?.[4],
          isStub: c.values?.[6],
          metadata: JSON.parse(String(c.values?.[3])) as {
            demo_seed_kind: string;
            demo_fake_connected: boolean;
            company_name: string;
            display_name: string;
            provider_name: string;
            source_category: string;
            disconnect_hidden: boolean;
            disconnectable: boolean;
            sync_disabled: boolean;
            overlaps_with: Record<string, unknown>;
          },
        },
      ]),
    );

    expect([...byType.keys()].sort()).toEqual([
      "alchemy_wallet",
      "email_inbound",
      "finch",
      "merge_accounting",
      "plaid",
      "stripe",
    ]);

    for (const entry of byType.values()) {
      expect(entry.metadata).toMatchObject({
        demo_seed_kind: "fake_connected_source",
        demo_fake_connected: true,
        company_name: "Brightline Systems Inc.",
        disconnect_hidden: true,
        disconnectable: false,
        sync_disabled: true,
      });
      expect(entry.metadata.source_category).toEqual(expect.any(String));
      expect(entry.metadata.provider_name).toEqual(expect.any(String));
      expect(entry.metadata.display_name).toEqual(expect.any(String));
    }

    expect(byType.get("plaid")?.externalAccountIds).toEqual([
      "brainsaas_operating",
      "brainsaas_reserve",
    ]);
    expect(byType.get("plaid")?.metadata.overlaps_with).toMatchObject({
      documents: ["bank_statement_2026-06.pdf"],
      ledger_account_ids: ["acct_brainsaas_operating", "acct_brainsaas_reserve"],
    });
    expect(byType.get("stripe")?.metadata.overlaps_with).toMatchObject({
      documents: ["bank_statement_2026-06.pdf", "ar_aging_2026-06-30.xlsx"],
    });
    expect(byType.get("finch")?.metadata.overlaps_with).toMatchObject({
      documents: ["payroll_register_2026-06.xlsx"],
      pay_runs: ["2026-06A", "2026-06B"],
    });
    expect(byType.get("merge_accounting")?.metadata.overlaps_with.ap_invoice_ids).toHaveLength(3);
    expect(byType.get("merge_accounting")?.metadata.overlaps_with.ar_invoice_ids).toHaveLength(4);
    expect(byType.get("alchemy_wallet")?.isStub).toBe(true);
    expect(byType.get("email_inbound")?.isStub).toBe(true);
  });

  it("backdates payment-instruction history out of the 24h fraud window", async () => {
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const backdate = scopedCalls.find((c) =>
      c.sql.includes("ledger_counterparty_payment_instructions"),
    );
    expect(backdate).toBeDefined();
    expect(backdate!.sql).toContain("interval '30 days'");
    expect(backdate!.values).toEqual([TENANT]);
  });

  it("writes a default AP funding account into the tenants row", async () => {
    const { pool, audit } = deps();
    const result = await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const tenantUpsert = scopedCalls.find((c) =>
      c.sql.includes("INSERT INTO tenants (id, kind, default_ap_account_id)"),
    );
    expect(tenantUpsert).toBeDefined();
    expect(tenantUpsert!.values).toEqual([TENANT, "acct_brainsaas_operating"]);

    const memberInsert = scopedCalls.find((c) => c.sql.includes("INSERT INTO members"));
    expect(memberInsert).toBeDefined();
    expect(memberInsert!.values).toEqual([
      TENANT,
      ACTOR,
      `bootstrap+${TENANT}@brain.invalid`,
      "Demo Owner",
      ["ap", "ar", "treasury", "payroll", "reconciliation"],
      "9223372036854775807",
    ]);
    expect(result.agentId).not.toBe(ACTOR);
  });

  it("inserts one active policy and deactivates prior ones", async () => {
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const deactivate = scopedCalls.find((c) => c.sql.includes("SET state = 'deactivated'"));
    expect(deactivate).toBeDefined();

    const insertPolicy = scopedCalls.find((c) => c.sql.includes("INSERT INTO policies"));
    expect(insertPolicy).toBeDefined();
    // version comes from the COALESCE(MAX(version)+1) stub → 1.
    expect(insertPolicy!.values?.[2]).toBe(1);
    expect(insertPolicy!.values?.[1]).toBe(TENANT);

    const policy = JSON.parse(String(insertPolicy!.values?.[3])) as PolicyDocument;
    expect(policy.rules).not.toContainEqual(
      expect.objectContaining({ id: "ar-auto-agent-action", execute: "auto" }),
    );
    expect(policy.rules).toContainEqual({
      id: "ar-agent-action-requires-review",
      applies_to: ["agent_action"],
      when: { "agent.confidence.gte": 0.6 },
      execute: "confirm",
      require: "single_signer",
    });

    const ordinaryAgentAction: Action = {
      kind: "agent_action",
      counterparty_id: null,
      amount: null,
      agent_role: "collections",
      timestamp: new Date("2026-06-30T00:00:00Z"),
      confidence: 0.72,
    };
    expect(evaluate(policy, ordinaryAgentAction)).toMatchObject({
      outcome: "confirm",
      matched_rule_id: "ar-agent-action-requires-review",
      required_approvers: ["signer"],
    });

    const largeAgentAction: Action = {
      ...ordinaryAgentAction,
      amount: { currency: "USD", value: "500000.01" },
    };
    expect(evaluate(policy, largeAgentAction)).toMatchObject({
      outcome: "confirm",
      matched_rule_id: "ar-confirm-above-500k",
      required_approvers: ["admin"],
    });
  });

  it("plants pending Needs Review agent proposals for overdue receivables", async () => {
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const proposalInserts = scopedCalls.filter((c) => c.sql.includes("INSERT INTO proposals"));
    expect(proposalInserts).toHaveLength(2);

    const actions = proposalInserts.map(
      (c) => JSON.parse(String(c.values?.[3])) as Record<string, unknown>,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "agent_action",
          type: "collections",
          mode: "propose",
          risk_band: "elevated",
          action_id: "demo.collections.ar-midmarket-001",
        }),
        expect.objectContaining({
          kind: "agent_action",
          type: "collections",
          mode: "propose",
          risk_band: "high",
          action_id: "demo.collections.ar-startupx-001",
        }),
      ]),
    );

    for (const call of proposalInserts) {
      expect(call.values?.[1]).toBe(TENANT);
      expect(call.values?.[4]).toBe(1);
      expect(call.values?.[5]).toContain("ar-agent-action-requires-review");
      expect(String(call.values?.[6])).toMatch(/^demo:brainsaas:proposal:/);
      expect(call.sql).toContain("'confirm'");
      expect(call.sql).toContain("'pending'");
      expect(call.sql).toContain("ARRAY['signer']");
      expect(call.sql).toContain("ON CONFLICT (tenant_id, proposal_dedup_key)");
    }

    const auditEvents = audit.events.filter((event) => event.action === "agent.action.proposed");
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.every((event) => event.outcome === "confirm")).toBe(true);
    expect(
      auditEvents.every(
        (event) =>
          (event.outputs as { matched_rule_id?: string }).matched_rule_id ===
          "ar-agent-action-requires-review",
      ),
    ).toBe(true);
  });

  it("deletes and re-inserts the demo payment agent", async () => {
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const del = scopedCalls.find((c) =>
      c.sql.includes("DELETE FROM agents WHERE display_name = 'Demo Payment Agent'"),
    );
    expect(del).toBeDefined();

    const insertAgent = scopedCalls.find((c) => c.sql.includes("INSERT INTO agents"));
    expect(insertAgent).toBeDefined();
    // No smart account configured → zero address.
    expect(insertAgent!.values?.[3]).toBe("0x0000000000000000000000000000000000000000");
  });

  it("uses the configured smart account address for the demo agent", async () => {
    process.env["BRAIN_ONCHAIN_SMART_ACCOUNT"] = "0xSMART00000000000000000000000000000000AA";
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const insertAgent = scopedCalls.find((c) => c.sql.includes("INSERT INTO agents"));
    expect(insertAgent!.values?.[3]).toBe("0xSMART00000000000000000000000000000000AA");
  });

  it("inserts AP invoices with overdue status for past-due dates", async () => {
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const apInvoiceInserts = scopedCalls.filter(
      (c) => c.sql.includes("INSERT INTO ledger_invoices") && c.sql.includes("$12::jsonb"),
    );
    // 3 AP invoices.
    expect(apInvoiceInserts).toHaveLength(3);
    // quickpay invoice is due_in_days -4 → "overdue". Param order:
    // $1 id, $2 owner, $3 invoice_number, $4 cp, $5 amount_due, $6 issue_date,
    // $7 due_date, $8 status (amount_paid + currency are SQL literals).
    const statuses = apInvoiceInserts.map((c) => c.values?.[7]);
    expect(statuses).toContain("overdue");
    expect(statuses).toContain("sent");
  });

  it("inserts one source document per AP invoice", async () => {
    const { pool, audit } = deps();
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const docInserts = scopedCalls.filter((c) => c.sql.includes("INSERT INTO ledger_documents"));
    expect(docInserts).toHaveLength(3);
  });
});
