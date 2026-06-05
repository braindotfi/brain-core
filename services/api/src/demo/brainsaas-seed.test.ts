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
    await seedBrainSaasDemo(pool, audit, TENANT, ACTOR);

    const tenantUpsert = scopedCalls.find((c) =>
      c.sql.includes("INSERT INTO tenants (id, default_ap_account_id)"),
    );
    expect(tenantUpsert).toBeDefined();
    expect(tenantUpsert!.values).toEqual([TENANT, "acct_brainsaas_operating"]);
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
