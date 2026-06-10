/**
 * Unit tests for PostgresSourceRepository (fix/main-green): a substring-routed
 * fake pool stands in for Postgres so every method + the credential-encryption
 * branches are covered without a DB. Credential round-trip uses the real
 * AES-256-GCM helpers from @brain/shared.
 */

import { describe, expect, it } from "vitest";
import { encryptCredentials, newTenantId } from "@brain/shared";
import type { Pool } from "pg";
import { PostgresSourceRepository } from "./PostgresSourceRepository.js";
import type { SourceRecord } from "./types.js";

const TENANT = newTenantId();
const KEY = Buffer.alloc(32, 7);
const KEY_ID = "test-key-v1";

function record(over: Partial<SourceRecord> = {}): SourceRecord {
  const now = new Date().toISOString();
  return {
    id: "src_1",
    tenant_id: TENANT,
    type: "plaid",
    status: "active",
    metadata: { foo: "bar" },
    external_account_ids: ["ext_1"],
    last_synced_at: null,
    error_message: null,
    is_stub: false,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

/** DB-shaped row for RETURNING/SELECT *, derived from a SourceRecord. */
function dbRow(rec: SourceRecord, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: rec.id,
    tenant_id: rec.tenant_id,
    type: rec.type,
    status: rec.status,
    metadata: rec.metadata,
    external_account_ids: rec.external_account_ids ?? [],
    last_synced_at: rec.last_synced_at,
    error_message: rec.error_message,
    is_stub: rec.is_stub,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    ...over,
  };
}

interface Call {
  sql: string;
  params: unknown[];
}

function fakePool(handler: (sql: string, params: unknown[]) => { rows: unknown[] }): {
  pool: Pool;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (
        /^(BEGIN|COMMIT|ROLLBACK)/.test(sql) ||
        sql.includes("set_config") ||
        sql.startsWith("SET ")
      ) {
        return { rows: [], rowCount: 0 };
      }
      calls.push({ sql, params });
      return handler(sql, params);
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, calls };
}

function insertReturning(): (sql: string, params: unknown[]) => { rows: unknown[] } {
  // Echo the inserted row back from the INSERT params (mirrors RETURNING *).
  return (sql, params) => {
    if (sql.includes("INSERT INTO raw_sources")) {
      return {
        rows: [
          {
            id: params[0],
            tenant_id: params[1],
            type: params[2],
            status: params[3],
            metadata: JSON.parse(params[6] as string),
            external_account_ids: params[7],
            last_synced_at: params[8],
            error_message: params[9],
            is_stub: params[10],
            created_at: params[11],
            updated_at: params[12],
          },
        ],
      };
    }
    return { rows: [] };
  };
}

describe("PostgresSourceRepository — insert / encryption", () => {
  it("insert() stores NULL credentials", async () => {
    const { pool, calls } = fakePool(insertReturning());
    const repo = new PostgresSourceRepository({
      pool,
      credentialKey: KEY,
      credentialKeyId: KEY_ID,
    });
    const out = await repo.insert(record());
    expect(out.id).toBe("src_1");
    const insert = calls.find((c) => c.sql.includes("INSERT INTO raw_sources"))!;
    expect(insert.params[4]).toBeNull(); // encrypted_credentials
    expect(insert.params[5]).toBeNull(); // credential_key_id
  });

  it("insertWithCredentials() encrypts for a credential source type (plaid)", async () => {
    const { pool, calls } = fakePool(insertReturning());
    const repo = new PostgresSourceRepository({
      pool,
      credentialKey: KEY,
      credentialKeyId: KEY_ID,
    });
    await repo.insertWithCredentials(record({ type: "plaid" }), { access_token: "secret" }, [
      "ext_9",
    ]);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO raw_sources"))!;
    expect(Buffer.isBuffer(insert.params[4])).toBe(true); // encrypted ciphertext
    expect(insert.params[5]).toBe(KEY_ID);
    expect(insert.params[7]).toEqual(["ext_9"]); // external_account_ids
  });

  it("encrypts credential material for ANY source type (vault is type-agnostic)", async () => {
    // The credential vault serves every authenticated connector, not a
    // plaid/stripe allowlist (ingestion architecture Phase 1).
    const { pool, calls } = fakePool(insertReturning());
    const repo = new PostgresSourceRepository({
      pool,
      credentialKey: KEY,
      credentialKeyId: KEY_ID,
    });
    await repo.insertWithCredentials(record({ type: "eth_address" }), { secret: "x" });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO raw_sources"))!;
    expect(Buffer.isBuffer(insert.params[4])).toBe(true);
    expect(insert.params[5]).toBe(KEY_ID);
  });

  it("fails closed when credentials are supplied for plaid but no credential key is configured", async () => {
    // Previously silently wrote NULL into encrypted_credentials, leaving the
    // source unusable at execution time. Peer review caught it; this test
    // pins the fail-closed behavior so the regression cannot recur.
    const { pool } = fakePool(insertReturning());
    const repo = new PostgresSourceRepository({ pool }); // no key
    await expect(
      repo.insertWithCredentials(record({ type: "plaid" }), { access_token: "x" }),
    ).rejects.toThrow(/refusing to insert plaid source with NULL encrypted_credentials/);
  });

  it("fails closed for stripe with credentials + no key", async () => {
    const { pool } = fakePool(insertReturning());
    const repo = new PostgresSourceRepository({ pool });
    await expect(
      repo.insertWithCredentials(record({ type: "stripe" }), { sk_test: "y" }),
    ).rejects.toThrow(/refusing to insert stripe source/);
  });

  it("fails closed for any type when credential material is supplied without a key", async () => {
    const { pool } = fakePool(insertReturning());
    const repo = new PostgresSourceRepository({ pool }); // no key
    await expect(
      repo.insertWithCredentials(record({ type: "eth_address" }), { pub: "0xabc" }),
    ).rejects.toThrow(/refusing to insert eth_address source/);
  });

  it("permits an empty credentials object with no key (public-credential sources)", async () => {
    // Public-credential sources (watched addresses) have no server-side
    // secret to encrypt; an empty object stores NULL without a key.
    const { pool, calls } = fakePool(insertReturning());
    const repo = new PostgresSourceRepository({ pool }); // no key
    await repo.insertWithCredentials(record({ type: "eth_address" }), {});
    const insert = calls.find((c) => c.sql.includes("INSERT INTO raw_sources"))!;
    expect(insert.params[4]).toBeNull();
  });
});

describe("PostgresSourceRepository — updateCredentials (refresh primitive)", () => {
  it("re-encrypts under the current key and stamps the key id", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 1 }) as never);
    const repo = new PostgresSourceRepository({
      pool,
      credentialKey: KEY,
      credentialKeyId: "rotated-key-v2",
    });
    const ok = await repo.updateCredentials(TENANT, "src_1", { access_token: "fresh" });
    expect(ok).toBe(true);
    const update = calls.find((c) => c.sql.includes("SET encrypted_credentials"))!;
    expect(update.params[0]).toBe("src_1");
    expect(Buffer.isBuffer(update.params[1])).toBe(true);
    expect(update.params[2]).toBe("rotated-key-v2");
  });

  it("refuses to update without a configured key", async () => {
    const repo = new PostgresSourceRepository({ pool: fakePool(() => ({ rows: [] })).pool });
    await expect(repo.updateCredentials(TENANT, "src_1", { t: "x" })).rejects.toThrow(
      /refusing to update credentials/,
    );
  });
});

describe("PostgresSourceRepository — reads", () => {
  it("findById returns a record, or null when absent", async () => {
    const rec = record();
    const found = new PostgresSourceRepository({
      pool: fakePool(() => ({ rows: [dbRow(rec)] })).pool,
    });
    expect((await found.findById(TENANT, "src_1"))?.id).toBe("src_1");

    const missing = new PostgresSourceRepository({ pool: fakePool(() => ({ rows: [] })).pool });
    expect(await missing.findById(TENANT, "nope")).toBeNull();
  });

  it("list applies type/status filters and clamps the limit", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [dbRow(record())] }));
    const repo = new PostgresSourceRepository({ pool });
    const out = await repo.list(TENANT, { type: "plaid", status: "active", limit: 9999 });
    expect(out).toHaveLength(1);
    const q = calls[0]!;
    expect(q.sql).toContain("WHERE");
    expect(q.params).toEqual(["plaid", "active", 500]); // limit clamped to 500
  });

  it("list with no filters omits WHERE and uses default limit", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    const repo = new PostgresSourceRepository({ pool });
    await repo.list(TENANT, {});
    expect(calls[0]!.sql).not.toContain("WHERE");
    expect(calls[0]!.params).toEqual([50]);
  });

  it("findByExternalAccountId returns a record, or null", async () => {
    const hit = new PostgresSourceRepository({
      pool: fakePool(() => ({ rows: [dbRow(record())] })).pool,
    });
    expect((await hit.findByExternalAccountId(TENANT, "ext_1"))?.id).toBe("src_1");
    const miss = new PostgresSourceRepository({ pool: fakePool(() => ({ rows: [] })).pool });
    expect(await miss.findByExternalAccountId(TENANT, "ext_x")).toBeNull();
  });
});

describe("PostgresSourceRepository — updateStatus", () => {
  it("returns the updated record", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [dbRow(record({ status: "error" }))] }));
    const repo = new PostgresSourceRepository({ pool });
    const out = await repo.updateStatus(TENANT, "src_1", "error", { error_message: "boom" });
    expect(out?.status).toBe("error");
    expect(calls[0]!.params).toEqual(["error", "boom", null, "src_1"]);
  });

  it("returns null when the row is absent", async () => {
    const repo = new PostgresSourceRepository({ pool: fakePool(() => ({ rows: [] })).pool });
    expect(await repo.updateStatus(TENANT, "nope", "paused")).toBeNull();
  });
});

describe("PostgresSourceRepository — resolveCredentials", () => {
  it("returns null when no key is configured (no query)", async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    const repo = new PostgresSourceRepository({ pool });
    expect(await repo.resolveCredentials(TENANT, "src_1")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("decrypts stored credentials (AES round-trip)", async () => {
    const creds = { access_token: "plaid-access-xyz" };
    const { ciphertext } = encryptCredentials(creds, KEY, KEY_ID);
    const repo = new PostgresSourceRepository({
      pool: fakePool(() => ({ rows: [{ encrypted_credentials: ciphertext }] })).pool,
      credentialKey: KEY,
      credentialKeyId: KEY_ID,
    });
    expect(await repo.resolveCredentials(TENANT, "src_1")).toEqual(creds);
  });

  it("returns null when the stored ciphertext is null", async () => {
    const repo = new PostgresSourceRepository({
      pool: fakePool(() => ({ rows: [{ encrypted_credentials: null }] })).pool,
      credentialKey: KEY,
      credentialKeyId: KEY_ID,
    });
    expect(await repo.resolveCredentials(TENANT, "src_1")).toBeNull();
  });

  it("returns null when the row is absent", async () => {
    const repo = new PostgresSourceRepository({
      pool: fakePool(() => ({ rows: [] })).pool,
      credentialKey: KEY,
      credentialKeyId: KEY_ID,
    });
    expect(await repo.resolveCredentials(TENANT, "missing")).toBeNull();
  });
});
