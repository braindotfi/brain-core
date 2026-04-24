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
    pool: { connect: async () => client } as unknown as import("pg").Pool,
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
    expect(log[1]).toContain("SELECT event_hash");
    expect(log[2]).toContain("INSERT INTO audit_events");
    expect(log[3]).toBe("COMMIT");
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
    } as unknown as import("pg").Pool;
    const emitter = new PostgresAuditEmitter(pool);

    await expect(emitter.emit(baseEvent())).rejects.toThrow(/boom/);
    expect(log).toContain("ROLLBACK");
    expect(failingClient.released).toBe(true);
  });
});
