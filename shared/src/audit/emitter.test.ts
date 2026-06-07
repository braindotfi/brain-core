import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { newTenantId, newUserId } from "../ids.js";
import { InMemoryAuditEmitter, PostgresAuditEmitter } from "./emitter.js";
import { hashEvent } from "./hash.js";
import type { AuditEventInput } from "./types.js";

function baseEvent(): AuditEventInput {
  return {
    tenantId: newTenantId(),
    layer: "raw",
    actor: newUserId(),
    action: "raw.ingest",
    inputs: { sha256: "a".repeat(64) },
    outputs: { raw_id: "raw_1", deduplicated: false },
  };
}

describe("InMemoryAuditEmitter", () => {
  it("chains events per tenant", async () => {
    const emitter = new InMemoryAuditEmitter();
    const tenant = newTenantId();
    const a = await emitter.emit({ ...baseEvent(), tenantId: tenant });
    const b = await emitter.emit({ ...baseEvent(), tenantId: tenant });
    expect(a.prevEventHash).toBeNull();
    expect(b.prevEventHash).toBe(a.eventHash);
    expect(a.eventHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps chains independent across tenants", async () => {
    const emitter = new InMemoryAuditEmitter();
    const tA = newTenantId();
    const tB = newTenantId();
    const a1 = await emitter.emit({ ...baseEvent(), tenantId: tA });
    const b1 = await emitter.emit({ ...baseEvent(), tenantId: tB });
    const a2 = await emitter.emit({ ...baseEvent(), tenantId: tA });
    expect(b1.prevEventHash).toBeNull();
    expect(a2.prevEventHash).toBe(a1.eventHash);
  });

  it("recomputing the hash matches what the emitter stored", async () => {
    const emitter = new InMemoryAuditEmitter();
    const tenant = newTenantId();
    const ev = await emitter.emit({ ...baseEvent(), tenantId: tenant });
    const recomputed = hashEvent({
      event: { ...ev },
      id: ev.id,
      createdAt: ev.createdAt,
      prevEventHash: ev.prevEventHash,
    });
    expect(recomputed).toBe(ev.eventHash);
  });

  it("dedupes by idempotency key (same tenant + key returns the SAME event)", async () => {
    const emitter = new InMemoryAuditEmitter();
    const tenant = newTenantId();
    const a = await emitter.emit({ ...baseEvent(), tenantId: tenant, idempotencyKey: "k1" });
    const b = await emitter.emit({ ...baseEvent(), tenantId: tenant, idempotencyKey: "k1" });
    expect(b).toBe(a); // the existing event, not a duplicate
    expect(emitter.events).toHaveLength(1);
    // A different key writes a new event.
    await emitter.emit({ ...baseEvent(), tenantId: tenant, idempotencyKey: "k2" });
    expect(emitter.events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PostgresAuditEmitter — tested with a fake pool double.
// ---------------------------------------------------------------------------

function makeFakePgPool(rows: Array<{ event_hash: string }> = []) {
  const log: string[] = [];
  const client = {
    released: false,
    query: vi.fn(async (text: string, _values?: unknown[]) => {
      log.push(text.trim().split("\n")[0]!.trim());
      if (text.includes("SELECT event_hash")) {
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(() => {
      client.released = true;
    }),
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    client,
    log,
  };
}

describe("PostgresAuditEmitter", () => {
  it("wraps the INSERT in BEGIN/COMMIT and releases the client", async () => {
    const { pool, log, client } = makeFakePgPool();
    const emitter = new PostgresAuditEmitter(pool);

    const ev = await emitter.emit(baseEvent());
    expect(log[0]).toBe("BEGIN");
    expect(log[1]).toContain("set_config");
    // Per-tenant serialization lock BEFORE reading the chain tail (so the chain
    // cannot fork under concurrency).
    expect(log[2]).toContain("pg_advisory_xact_lock");
    expect(log[2]).toContain("hashtext($1)");
    expect(log[3]).toContain("SELECT event_hash");
    expect(log[4]).toContain("INSERT INTO audit_events");
    expect(log[5]).toBe("COMMIT");
    expect(client.released).toBe(true);
    expect(ev.prevEventHash).toBeNull();
    expect(ev.eventHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads prev_event_hash from the tenant's latest row", async () => {
    const priorHash = "b".repeat(64);
    const { pool } = makeFakePgPool([{ event_hash: priorHash }]);
    const emitter = new PostgresAuditEmitter(pool);

    const ev = await emitter.emit(baseEvent());
    expect(ev.prevEventHash).toBe(priorHash);
  });

  it("returns the existing event (no INSERT) on an idempotency-key hit", async () => {
    const existingId = "evt_existing";
    const existingHash = Buffer.from("c".repeat(64), "hex");
    const createdAt = new Date("2026-06-07T00:00:00.000Z");
    const log: string[] = [];
    const client = {
      released: false,
      query: vi.fn(async (text: string) => {
        log.push(text.trim().split("\n")[0]!.trim());
        if (text.includes("idempotency_key = $2")) {
          return {
            rows: [
              {
                id: existingId,
                event_hash: existingHash,
                prev_event_hash: null,
                created_at: createdAt,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(() => {
        client.released = true;
      }),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const emitter = new PostgresAuditEmitter(pool);

    const ev = await emitter.emit({ ...baseEvent(), idempotencyKey: "k1" });

    expect(ev.id).toBe(existingId);
    expect(ev.eventHash).toBe("c".repeat(64));
    expect(ev.prevEventHash).toBeNull();
    expect(ev.createdAt).toBe("2026-06-07T00:00:00.000Z");
    // It returned the existing row — NO new event was inserted.
    expect(log.some((s) => s.startsWith("INSERT"))).toBe(false);
    expect(log).toContain("COMMIT");
    expect(client.released).toBe(true);
  });

  it("passes idempotency_key as a column + value on INSERT when supplied", async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values: values ?? [] });
        return { rows: [], rowCount: 0 }; // no idempotency hit, empty tail → genesis insert
      }),
      release: vi.fn(),
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const emitter = new PostgresAuditEmitter(pool);

    await emitter.emit({ ...baseEvent(), idempotencyKey: "k1" });

    const insert = calls.find((c) => c.text.includes("INSERT INTO audit_events"));
    expect(insert).toBeDefined();
    expect(insert!.text).toContain("idempotency_key");
    expect(insert!.values).toContain("k1");
  });

  it("rolls back and rethrows on INSERT failure", async () => {
    const log: string[] = [];
    const failingClient = {
      released: false,
      query: vi.fn(async (text: string, _v?: unknown[]) => {
        log.push(text.trim().split("\n")[0]!.trim());
        if (text.startsWith("INSERT")) throw new Error("boom");
        if (text.includes("SELECT event_hash")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(() => {
        failingClient.released = true;
      }),
    };
    const pool = {
      connect: async () => failingClient,
    } as unknown as Pool;
    const emitter = new PostgresAuditEmitter(pool);

    await expect(emitter.emit(baseEvent())).rejects.toThrow(/boom/);
    expect(log).toContain("ROLLBACK");
    expect(failingClient.released).toBe(true);
  });
});
