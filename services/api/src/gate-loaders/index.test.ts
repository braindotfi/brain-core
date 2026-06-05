/**
 * Tests for the gate-loader factory functions.
 *
 * Each factory returns a closure wired to a Pool / LedgerService. We mock the
 * @brain/policy, @brain/execution and @brain/ledger primitives plus
 * `withTenantScope` (which we collapse to "call the callback with a fake
 * client") so the loaders run without a real database.
 */

import { describe, expect, it, vi } from "vitest";
import type * as BrainShared from "@brain/shared";

const {
  findAgent,
  findUser,
  resolveInvoiceShortcutFn,
  policyGetActive,
  policyDetectDuplicates,
  ledgerSumActiveReservations,
} = vi.hoisted(() => ({
  findAgent: vi.fn(),
  findUser: vi.fn(),
  resolveInvoiceShortcutFn: vi.fn(),
  policyGetActive: vi.fn(),
  policyDetectDuplicates: vi.fn(),
  ledgerSumActiveReservations: vi.fn(),
}));

vi.mock("@brain/policy", () => ({
  getActive: policyGetActive,
  detectDuplicates: policyDetectDuplicates,
}));

vi.mock("@brain/execution", () => ({
  findAgent,
  findUser,
  resolveInvoiceShortcut: resolveInvoiceShortcutFn,
}));

vi.mock("@brain/ledger", () => ({
  sumActiveReservations: ledgerSumActiveReservations,
}));

interface FakeClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

const scoped = vi.hoisted(() => ({ rows: [] as unknown[] }));
function setScopedRows(rows: unknown[]): void {
  scoped.rows = rows;
}

vi.mock("@brain/shared", async () => {
  const actual = await vi.importActual<typeof BrainShared>("@brain/shared");
  return {
    ...actual,
    withTenantScope: vi.fn(
      async (_pool: unknown, _tenantId: string, fn: (c: FakeClient) => Promise<unknown>) => {
        const client: FakeClient = {
          query: async () => ({ rows: scoped.rows }),
        };
        return fn(client);
      },
    ),
  };
});

import type { GatePaymentIntent, ServiceCallContext } from "@brain/shared";
import type { LedgerService } from "@brain/ledger";
import type { Pool } from "pg";
import {
  makeDetectDuplicates,
  makeInvoiceShortcutResolver,
  makeIsApproverActive,
  makeResolveAccount,
  makeResolveActivePolicyVersion,
  makeResolveAgent,
  makeResolveCounterparty,
  makeResolveEvidence,
  makeResolveRole,
  makeResolveSubjectOwnerTenant,
  makeResolveTenantFlags,
  makeSumActiveReservations,
  resolvePrincipalFromCtx,
} from "./index.js";

const POOL = {} as Pool;

function ctx(overrides: Partial<ServiceCallContext> = {}): ServiceCallContext {
  return {
    tenantId: "tnt_01TEST000000000000000000000",
    actor: "usr_01ACTOR0000000000000000000",
    ...overrides,
  };
}

describe("makeResolveAgent", () => {
  it("returns null when no agent row exists", async () => {
    findAgent.mockResolvedValueOnce(null);
    const resolve = makeResolveAgent(POOL);
    expect(await resolve(ctx(), "agent_x")).toBeNull();
  });

  it("maps an active payment agent to canExecutePayments=true", async () => {
    findAgent.mockResolvedValueOnce({ id: "agent_x", state: "active", role: "payment" });
    const resolve = makeResolveAgent(POOL);
    const out = await resolve(ctx(), "agent_x");
    expect(out).toEqual({
      id: "agent_x",
      state: "active",
      scope: { canExecutePayments: true },
    });
  });

  it("denies payment for a non-payment role", async () => {
    findAgent.mockResolvedValueOnce({ id: "agent_y", state: "active", role: "reconciliation" });
    const out = await makeResolveAgent(POOL)(ctx(), "agent_y");
    expect(out?.scope.canExecutePayments).toBe(false);
  });
});

describe("makeResolveTenantFlags", () => {
  it("defaults to false when no row", async () => {
    setScopedRows([]);
    const out = await makeResolveTenantFlags(POOL)(ctx(), "tnt_01TEST000000000000000000000");
    expect(out).toEqual({ requireBehaviorHash: false });
  });

  it("reads require_behavior_hash from the row", async () => {
    setScopedRows([{ require_behavior_hash: true }]);
    const out = await makeResolveTenantFlags(POOL)(ctx(), "tnt_01TEST000000000000000000000");
    expect(out).toEqual({ requireBehaviorHash: true });
  });
});

describe("makeResolveAccount", () => {
  function ledger(value: unknown): LedgerService {
    return { getAccount: vi.fn().mockResolvedValue(value) } as unknown as LedgerService;
  }

  it("returns null when the account is missing", async () => {
    const out = await makeResolveAccount(ledger(null))(ctx(), "acct_x");
    expect(out).toBeNull();
  });

  it("prefers the latest balance available_balance when present", async () => {
    const l = ledger({
      account: { id: "acct_x", status: "active", currency: "USD", available_balance: "1.00" },
      latest_balance: { available_balance: "999.00" },
    });
    const out = await makeResolveAccount(l)(ctx(), "acct_x");
    expect(out?.available_balance).toBe("999.00");
  });

  it("falls back to the account available_balance when no latest balance", async () => {
    const l = ledger({
      account: { id: "acct_x", status: "active", currency: "USD", available_balance: "5.00" },
      latest_balance: null,
    });
    const out = await makeResolveAccount(l)(ctx(), "acct_x");
    expect(out?.available_balance).toBe("5.00");
  });
});

describe("makeResolveCounterparty", () => {
  function ledger(value: unknown): LedgerService {
    return {
      findCounterpartyById: vi.fn().mockResolvedValue(value),
    } as unknown as LedgerService;
  }

  it("returns null when missing", async () => {
    expect(await makeResolveCounterparty(ledger(null))(ctx(), "cp_x")).toBeNull();
  });

  it("projects counterparty fields, defaulting nullable ones", async () => {
    const out = await makeResolveCounterparty(ledger({ id: "cp_x", type: "vendor" }))(
      ctx(),
      "cp_x",
    );
    expect(out).toEqual({
      id: "cp_x",
      type: "vendor",
      risk_level: null,
      verified_status: null,
      agent_id: null,
      onchain_address: null,
    });
  });

  it("passes through agent + onchain fields when present", async () => {
    const out = await makeResolveCounterparty(
      ledger({
        id: "cp_x",
        type: "agent",
        risk_level: "low",
        verified_status: "document_verified",
        agent_id: "agent_z",
        onchain_address: "0xabc",
      }),
    )(ctx(), "cp_x");
    expect(out?.agent_id).toBe("agent_z");
    expect(out?.onchain_address).toBe("0xabc");
  });
});

describe("resolvePrincipalFromCtx", () => {
  it("defaults type=user and empty scopes", async () => {
    const out = await resolvePrincipalFromCtx(ctx());
    expect(out).toEqual({
      id: "usr_01ACTOR0000000000000000000",
      type: "user",
      scopes: [],
    });
  });

  it("honors explicit principalType + scopes", async () => {
    const out = await resolvePrincipalFromCtx(
      ctx({ principalType: "agent", scopes: ["ledger:read"] }),
    );
    expect(out.type).toBe("agent");
    expect(out.scopes).toEqual(["ledger:read"]);
  });
});

describe("makeResolveRole", () => {
  it("returns the agent role when an agent exists", async () => {
    findAgent.mockResolvedValueOnce({ role: "payment" });
    const out = await makeResolveRole(POOL)(ctx(), "agent_x");
    expect(out).toBe("payment");
  });

  it("falls back to the user role", async () => {
    findAgent.mockResolvedValueOnce(null);
    findUser.mockResolvedValueOnce({ role: "owner" });
    const out = await makeResolveRole(POOL)(ctx(), "usr_x");
    expect(out).toBe("owner");
  });

  it("returns null when neither exists", async () => {
    findAgent.mockResolvedValueOnce(null);
    findUser.mockResolvedValueOnce(null);
    expect(await makeResolveRole(POOL)(ctx(), "usr_x")).toBeNull();
  });
});

describe("makeIsApproverActive", () => {
  it("returns true for an active agent", async () => {
    findAgent.mockResolvedValueOnce({ state: "active" });
    expect(await makeIsApproverActive(POOL)(ctx(), "agent_x")).toBe(true);
  });

  it("returns false for a non-active agent", async () => {
    findAgent.mockResolvedValueOnce({ state: "quarantined" });
    expect(await makeIsApproverActive(POOL)(ctx(), "agent_x")).toBe(false);
  });

  it("treats an existing user as an active approver", async () => {
    findAgent.mockResolvedValueOnce(null);
    findUser.mockResolvedValueOnce({ id: "usr_x" });
    expect(await makeIsApproverActive(POOL)(ctx(), "usr_x")).toBe(true);
  });

  it("returns false when neither agent nor user exists", async () => {
    findAgent.mockResolvedValueOnce(null);
    findUser.mockResolvedValueOnce(null);
    expect(await makeIsApproverActive(POOL)(ctx(), "usr_x")).toBe(false);
  });
});

describe("makeResolveSubjectOwnerTenant", () => {
  it("reads owner_id for a payment_intent subject", async () => {
    setScopedRows([{ owner_id: "tnt_owner" }]);
    const out = await makeResolveSubjectOwnerTenant(POOL)(ctx(), {
      type: "payment_intent",
      id: "pi_1",
    });
    expect(out).toBe("tnt_owner");
  });

  it("reads tenant_id for a proposal subject", async () => {
    setScopedRows([{ tenant_id: "tnt_prop" }]);
    const out = await makeResolveSubjectOwnerTenant(POOL)(ctx(), {
      type: "proposal",
      id: "prop_1",
    });
    expect(out).toBe("tnt_prop");
  });

  it("returns null when no row found", async () => {
    setScopedRows([]);
    const out = await makeResolveSubjectOwnerTenant(POOL)(ctx(), {
      type: "payment_intent",
      id: "pi_missing",
    });
    expect(out).toBeNull();
  });
});

describe("makeResolveActivePolicyVersion", () => {
  it("returns the active policy version", async () => {
    policyGetActive.mockResolvedValueOnce({ version: 7 });
    expect(await makeResolveActivePolicyVersion(POOL)(ctx())).toBe(7);
  });

  it("returns null when no active policy", async () => {
    policyGetActive.mockResolvedValueOnce(null);
    expect(await makeResolveActivePolicyVersion(POOL)(ctx())).toBeNull();
  });
});

describe("makeInvoiceShortcutResolver", () => {
  function ledger(overrides: Record<string, unknown> = {}): LedgerService {
    return {
      findInvoiceById: vi.fn(),
      listAccounts: vi.fn(),
      ...overrides,
    } as unknown as LedgerService;
  }

  it("wires resolveInvoice / listApAccounts / resolveDefaultApAccount into resolveInvoiceShortcut", async () => {
    const findInvoiceById = vi.fn().mockResolvedValue({
      id: "inv_1",
      counterparty_id: "cp_1",
      amount_due: 100,
      amount_paid: 0,
      currency: "USD",
      status: "sent",
      linked_document_ids: ["doc_1"],
      linked_transaction_ids: [],
    });
    const listAccounts = vi.fn().mockResolvedValue({
      items: [
        { id: "acct_chk", account_type: "bank_checking" },
        { id: "acct_sav", account_type: "bank_savings" },
        { id: "acct_onchain", account_type: "onchain" },
      ],
    });
    const l = ledger({ findInvoiceById, listAccounts });

    // Capture the deps object the resolver builds and exercise each callback.
    resolveInvoiceShortcutFn.mockImplementation(
      async (
        deps: {
          resolveInvoice: (c: ServiceCallContext, id: string) => Promise<unknown>;
          listApAccounts: (c: ServiceCallContext) => Promise<string[]>;
          resolveDefaultApAccount: (c: ServiceCallContext) => Promise<string | null>;
        },
        callCtx: ServiceCallContext,
        invoiceId: string,
      ) => {
        const inv = await deps.resolveInvoice(callCtx, invoiceId);
        const apAccounts = await deps.listApAccounts(callCtx);
        setScopedRows([{ default_ap_account_id: "acct_default" }]);
        const dflt = await deps.resolveDefaultApAccount(callCtx);
        return { inv, apAccounts, dflt };
      },
    );

    const out = (await makeInvoiceShortcutResolver(l, POOL)(ctx(), "inv_1")) as unknown as {
      inv: { id: string; amount_due: string };
      apAccounts: string[];
      dflt: string | null;
    };

    expect(out.inv.id).toBe("inv_1");
    expect(out.inv.amount_due).toBe("100");
    // onchain account filtered out.
    expect(out.apAccounts).toEqual(["acct_chk", "acct_sav"]);
    expect(out.dflt).toBe("acct_default");
  });

  it("resolveInvoice returns null when the invoice is missing", async () => {
    const findInvoiceById = vi.fn().mockResolvedValue(null);
    const l = ledger({ findInvoiceById });
    resolveInvoiceShortcutFn.mockImplementation(
      async (
        deps: { resolveInvoice: (c: ServiceCallContext, id: string) => Promise<unknown> },
        callCtx: ServiceCallContext,
        invoiceId: string,
      ) => deps.resolveInvoice(callCtx, invoiceId),
    );
    const out = await makeInvoiceShortcutResolver(l, POOL)(ctx(), "inv_missing");
    expect(out).toBeNull();
  });
});

describe("makeSumActiveReservations", () => {
  it("delegates to ledger.sumActiveReservations inside tenant scope", async () => {
    ledgerSumActiveReservations.mockResolvedValueOnce("42.00");
    const out = await makeSumActiveReservations(POOL)(ctx(), "acct_1");
    expect(out).toBe("42.00");
  });
});

describe("makeResolveEvidence", () => {
  it("returns [] when the intent has no evidence ids", async () => {
    const intent = { evidence_ids: [] } as unknown as GatePaymentIntent;
    expect(await makeResolveEvidence(POOL)(ctx(), intent)).toEqual([]);
  });

  it("projects raw_parsed rows and maps trust level by parser", async () => {
    const capturedAt = new Date("2026-01-01T00:00:00Z");
    setScopedRows([
      {
        id: "rp_1",
        raw_artifact_id: "raw_1",
        parser: "plaid",
        extracted: { a: 1 },
        extracted_at: capturedAt,
      },
      {
        id: "rp_2",
        raw_artifact_id: "raw_2",
        parser: "custom",
        extracted: { b: 2 },
        extracted_at: capturedAt,
      },
    ]);
    const intent = { evidence_ids: ["rp_1", "rp_2"] } as unknown as GatePaymentIntent;
    const out = await makeResolveEvidence(POOL)(ctx(), intent);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "rp_1",
      kind: "plaid",
      extracted: { a: 1 },
      sourceArtifactId: "raw_1",
      capturedAt,
      trustLevel: "high",
    });
    expect(out[1]?.trustLevel).toBe("medium");
  });
});

describe("makeDetectDuplicates", () => {
  it("delegates to policy.detectDuplicates inside tenant scope", async () => {
    const expected = { duplicates: [] };
    policyDetectDuplicates.mockResolvedValueOnce(expected);
    const out = await makeDetectDuplicates(POOL)(ctx(), {
      intentId: "pi_1",
    } as unknown as Parameters<ReturnType<typeof makeDetectDuplicates>>[1]);
    expect(out).toBe(expected);
  });
});
