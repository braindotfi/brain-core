import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, isBrainError } from "@brain/api/shared";
import { LedgerService } from "./LedgerService.js";

function fakePool(rows: unknown[] = []): {
  pool: import("pg").Pool;
  released: { count: number };
} {
  const released = { count: 0 };
  const client = {
    query: vi.fn(async (text: string) => {
      // Bookkeeping/SET calls — return empty.
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
      return { rows, rowCount: rows.length };
    }),
    release: () => {
      released.count += 1;
    },
  };
  const pool = {
    connect: async () => client,
  } as unknown as import("pg").Pool;
  return { pool, released };
}

const audit = new InMemoryAuditEmitter();

describe("LedgerService — limit clamping and reads", () => {
  it("clamps account limit to default 50 when omitted", async () => {
    const { pool } = fakePool([]);
    const service = new LedgerService({ pool, audit });
    const result = await service.listAccounts({ tenantId: "tnt_test", actor: "user_test" }, { limit: 0 });
    expect(result.items).toEqual([]);
    expect(result.next_cursor).toBeNull();
  });

  it("clamps requested limit above max", async () => {
    const { pool } = fakePool([]);
    const service = new LedgerService({ pool, audit });
    const result = await service.listTransactions(
      { tenantId: "tnt_test", actor: "user_test" },
      { limit: 99999 },
    );
    expect(result.items).toEqual([]);
  });

  it("returns null when account is missing", async () => {
    const { pool } = fakePool([]); // no rows -> findAccountById returns null
    const service = new LedgerService({ pool, audit });
    const result = await service.getAccount(
      { tenantId: "tnt_test", actor: "user_test" },
      "acct_DOES_NOT_EXIST",
    );
    expect(result).toBeNull();
  });
});

describe("LedgerService — Phase-2 write stubs throw 'not implemented'", () => {
  it("upsertAccount throws", async () => {
    const { pool } = fakePool();
    const service = new LedgerService({ pool, audit });
    await expect(
      service.upsertAccount(
        { tenantId: "tnt_test", actor: "user_test" },
        {
          external_account_id: "ext_1",
          account_type: "bank_checking",
          name: "Chase",
          currency: "USD",
          status: "active",
          source_ids: [],
          evidence_ids: [],
          provenance: "extracted",
          confidence: 1.0,
        },
      ),
    ).rejects.toSatisfy((err) => isBrainError(err) && err.code === "internal_server_error");
  });

  it("recordTransaction throws", async () => {
    const { pool } = fakePool();
    const service = new LedgerService({ pool, audit });
    await expect(
      service.recordTransaction(
        { tenantId: "tnt_test", actor: "user_test" },
        {
          account_id: "acct_test",
          external_transaction_id: "ext_t1",
          amount: "10.00",
          currency: "USD",
          direction: "outflow",
          transaction_date: new Date().toISOString(),
          status: "posted",
          source_ids: [],
          evidence_ids: [],
          provenance: "extracted",
          confidence: 0.9,
        },
      ),
    ).rejects.toSatisfy((err) => isBrainError(err));
  });

  it("normalizeFromRaw throws", async () => {
    const { pool } = fakePool();
    const service = new LedgerService({ pool, audit });
    await expect(
      service.normalizeFromRaw({ tenantId: "tnt_test", actor: "user_test" }, "prs_x"),
    ).rejects.toSatisfy((err) => isBrainError(err));
  });
});
