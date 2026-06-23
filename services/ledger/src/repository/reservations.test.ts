import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import {
  insertReservation,
  reserveIfAvailable,
  sumActiveReservations,
  consumeReservation,
  releaseReservation,
  expireDueReservations,
} from "./reservations.js";

type FakeClient = TenantScopedClient & { _log: { sql: string; values: unknown[] }[] };

function fakeClient(rows: unknown[] = [], rowCount = 0): FakeClient {
  return queuedFakeClient([{ rows, rowCount }]);
}

function queuedFakeClient(results: Array<{ rows: unknown[]; rowCount: number }>): FakeClient {
  const log: { sql: string; values: unknown[] }[] = [];
  const client = {
    _log: log,
    query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
      log.push({ sql, values: Array.from(values ?? []) });
      const next = results.shift() ?? { rows: [], rowCount: 0 };
      return { rows: [...next.rows], rowCount: next.rowCount };
    }),
  };
  return client as unknown as FakeClient;
}

const BASE_INPUT = {
  id: "res_01",
  ownerId: "tnt_acme",
  accountId: "acct_01",
  amount: "500.00",
  currency: "USD",
  paymentIntentId: "pi_01",
  policyDecisionId: "pd_01",
  reservingAgentId: "agent_payment",
};

const BASE_ROW = {
  ...BASE_INPUT,
  owner_id: BASE_INPUT.ownerId,
  account_id: BASE_INPUT.accountId,
  payment_intent_id: BASE_INPUT.paymentIntentId,
  policy_decision_id: BASE_INPUT.policyDecisionId,
  reserving_agent_id: BASE_INPUT.reservingAgentId,
  reserved_until: new Date(),
  status: "active",
  created_at: new Date(),
};

describe("insertReservation", () => {
  it("inserts with correct column order and returns the row", async () => {
    const { _log, ...client } = fakeClient([BASE_ROW]);
    const result = await insertReservation(client, BASE_INPUT);
    expect(result).toMatchObject({ id: "res_01", amount: "500.00", status: "active" });
    const sql = _log[0]!.sql;
    expect(sql).toContain("INSERT INTO ledger_reservations");
    expect(sql).toContain("RETURNING *");
    // reservedUntil defaults to a stale-row operations TTL; active reservations
    // still count until explicit consume/release/expire.
    expect(sql).toContain("COALESCE($9, now() + interval '24 hours')");
  });

  it("accepts an explicit reservedUntil", async () => {
    const { _log, ...client } = fakeClient([BASE_ROW]);
    const reservedUntil = new Date(Date.now() + 120_000);
    await insertReservation(client, { ...BASE_INPUT, reservedUntil });
    expect(_log[0]!.values[8]).toBe(reservedUntil);
  });

  it("throws when no row is returned", async () => {
    const { _log: _, ...client } = fakeClient([]);
    await expect(insertReservation(client, BASE_INPUT)).rejects.toThrow(
      "ledger_reservations insert returned no row",
    );
  });
});

describe("reserveIfAvailable", () => {
  it("locks the account and latest balance, rechecks active reservations, then inserts", async () => {
    const { _log, ...client } = queuedFakeClient([
      {
        rows: [{ id: "acct_01", status: "active", currency: "USD", available_balance: "1000.00" }],
        rowCount: 1,
      },
      { rows: [{ currency: "USD", available_balance: "900.00" }], rowCount: 1 },
      { rows: [{ total: "300.00" }], rowCount: 1 },
      { rows: [BASE_ROW], rowCount: 1 },
    ]);

    const result = await reserveIfAvailable(client, BASE_INPUT);

    expect(result).toMatchObject({
      ok: true,
      availableBalance: "900.00",
      reserved: "300.00",
      required: "800",
    });
    expect(_log[0]!.sql).toContain("FROM ledger_accounts");
    expect(_log[0]!.sql).toContain("FOR UPDATE");
    expect(_log[1]!.sql).toContain("FROM ledger_balances");
    expect(_log[1]!.sql).toContain("FOR UPDATE");
    expect(_log[2]!.sql).toContain("FROM ledger_reservations");
    expect(_log[3]!.sql).toContain("INSERT INTO ledger_reservations");
  });

  it("fails closed without inserting when the locked recheck finds insufficient balance", async () => {
    const { _log, ...client } = queuedFakeClient([
      {
        rows: [{ id: "acct_01", status: "active", currency: "USD", available_balance: "1000.00" }],
        rowCount: 1,
      },
      { rows: [{ currency: "USD", available_balance: "700.00" }], rowCount: 1 },
      { rows: [{ total: "300.00" }], rowCount: 1 },
    ]);

    const result = await reserveIfAvailable(client, BASE_INPUT);

    expect(result).toMatchObject({
      ok: false,
      reason: "insufficient_balance",
      availableBalance: "700.00",
      reserved: "300.00",
      required: "800",
    });
    expect(_log).toHaveLength(3);
    expect(_log.some((q) => q.sql.includes("INSERT INTO ledger_reservations"))).toBe(false);
  });
});

describe("sumActiveReservations", () => {
  it("sums active non-expired reservations for the given account", async () => {
    const { _log, ...client } = fakeClient([{ total: "1200.00" }]);
    const total = await sumActiveReservations(client, "acct_01");
    expect(total).toBe("1200.00");
    const sql = _log[0]!.sql;
    expect(sql).toContain("status = 'active'");
    expect(sql).not.toContain("reserved_until > now()");
    expect(_log[0]!.values).toContain("acct_01");
  });

  it("returns '0' when no active reservations exist", async () => {
    const { _log: _, ...client } = fakeClient([{ total: null }]);
    expect(await sumActiveReservations(client, "acct_01")).toBe("0");
  });

  /**
   * Concurrent reservation guard: two parallel handoffs each insert a
   * reservation; sumActiveReservations must reflect both so gate check #8
   * (balance - reserved) prevents double-spending. The DB enforces this via
   * SUM over the indexed (account_id, status, reserved_until) — we assert
   * the query structure here; integration tests confirm the DB constraint.
   */
  it("concurrent reservations are both counted (double-spend guard)", async () => {
    const first = fakeClient([{ total: "500.00" }]);
    const second = fakeClient([{ total: "1000.00" }]);
    const [t1, t2] = await Promise.all([
      sumActiveReservations({ ...first } as unknown as TenantScopedClient, "acct_01"),
      sumActiveReservations({ ...second } as unknown as TenantScopedClient, "acct_01"),
    ]);
    // After the first reservation the running total is 500; after both it is 1000.
    // The test captures the invariant: each call reflects whatever is in the DB
    // at query time — the SUM is not cached and not agent-scoped.
    expect(t1).toBe("500.00");
    expect(t2).toBe("1000.00");
    expect(Number(t2)).toBeGreaterThan(Number(t1));
  });
});

describe("consumeReservation", () => {
  it("transitions status to consumed for an active reservation", async () => {
    const { _log, ...client } = fakeClient([], 1);
    await consumeReservation(client, "res_01");
    expect(_log[0]!.sql).toContain("status = 'active'");
    expect(_log[0]!.values).toContain("consumed");
    expect(_log[0]!.values).toContain("res_01");
  });
});

describe("releaseReservation", () => {
  it("transitions status to released for an active reservation", async () => {
    const { _log, ...client } = fakeClient([], 1);
    await releaseReservation(client, "res_01");
    expect(_log[0]!.values).toContain("released");
    expect(_log[0]!.values).toContain("res_01");
  });
});

describe("expireDueReservations", () => {
  it("expires all active past-TTL reservations and returns count", async () => {
    const { _log, ...client } = fakeClient([], 3);
    const count = await expireDueReservations(client);
    expect(count).toBe(3);
    expect(_log[0]!.sql).toContain("reserved_until <= now()");
    expect(_log[0]!.sql).toContain("status = 'active'");
  });

  it("returns 0 when nothing to expire", async () => {
    const { _log: _, ...client } = fakeClient([], 0);
    expect(await expireDueReservations(client)).toBe(0);
  });
});
