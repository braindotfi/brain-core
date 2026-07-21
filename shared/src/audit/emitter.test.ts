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
    // Reuse ONE payload object: the idempotency contract is "same key => same
    // content", so both emits must carry identical content to dedupe.
    const input = { ...baseEvent(), tenantId: tenant, idempotencyKey: "k1" };
    const a = await emitter.emit(input);
    const b = await emitter.emit(input); // the existing event, not a duplicate
    expect(b).toBe(a);
    expect(emitter.events).toHaveLength(1);
    // A different key writes a new event.
    await emitter.emit({ ...input, idempotencyKey: "k2" });
    expect(emitter.events).toHaveLength(2);
  });

  it("throws audit_idempotency_conflict when a key is reused for different content", async () => {
    const emitter = new InMemoryAuditEmitter();
    const tenant = newTenantId();
    const input = { ...baseEvent(), tenantId: tenant, idempotencyKey: "k1" };
    await emitter.emit(input);
    // Same key, different action -> a different logical payload -> conflict.
    await expect(emitter.emit({ ...input, action: "raw.tombstone" })).rejects.toMatchObject({
      code: "audit_idempotency_conflict",
    });
    // The conflicting emit did not add a second event.
    expect(emitter.events).toHaveLength(1);
    // The identical payload still dedupes (returns the original).
    const again = await emitter.emit(input);
    expect(again).toBe(emitter.events[0]);
  });
});

// ---------------------------------------------------------------------------
// PostgresAuditEmitter — tested with a fake pool double.
// ---------------------------------------------------------------------------

function makeFakePgPool(rows: Array<{ event_hash: string | Buffer }> = []) {
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

  it("reads prev_event_hash from the tenant's latest row and exposes it as hex", async () => {
    // node-pg returns the BYTEA event_hash column as a Buffer; the emitter must
    // normalize it to the canonical hex string, not leak the Buffer through the
    // declared `string` contract (Codex c96283d P1).
    const priorHashHex = "b".repeat(64);
    const { pool } = makeFakePgPool([{ event_hash: Buffer.from(priorHashHex, "hex") }]);
    const emitter = new PostgresAuditEmitter(pool);

    const ev = await emitter.emit(baseEvent());
    expect(ev.prevEventHash).toBe(priorHashHex);
  });

  it("hashes over the HEX predecessor, not the raw BYTEA buffer", async () => {
    // The canonical hash contract requires a hex-string predecessor. If the raw
    // Buffer reaches hashEvent it canonicalizes as {"0":..,"1":..}, so the stored
    // hash would not recompute from the documented hex form (and a non-genesis
    // idempotent replay would falsely conflict). (Codex c96283d P1)
    const priorHashHex = "c".repeat(64);
    const { pool } = makeFakePgPool([{ event_hash: Buffer.from(priorHashHex, "hex") }]);
    const emitter = new PostgresAuditEmitter(pool);
    const input = baseEvent();

    const ev = await emitter.emit(input);
    const recomputed = hashEvent({
      event: input,
      id: ev.id,
      createdAt: ev.createdAt,
      prevEventHash: priorHashHex,
    });
    expect(ev.eventHash).toBe(recomputed);
  });

  it("returns the existing event (no INSERT) on an idempotency-key hit", async () => {
    const existingId = "evt_existing";
    const createdAt = new Date("2026-06-07T00:00:00.000Z");
    // The stored row represents a prior emit of THIS payload (the idempotency
    // contract: same key => same content), so its event_hash is that payload's
    // hash at the stored chain position. The emitter recomputes and matches it.
    const input: AuditEventInput = { ...baseEvent(), idempotencyKey: "k1" };
    const existingHashHex = hashEvent({
      event: input,
      id: existingId,
      createdAt: createdAt.toISOString(),
      prevEventHash: null,
    });
    const existingHash = Buffer.from(existingHashHex, "hex");
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
                hash_schema_version: 2,
                layer: input.layer,
                actor: input.actor,
                action: input.action,
                inputs: input.inputs,
                outputs: input.outputs,
                policy_version: null,
                policy_decision_id: null,
                before_state: null,
                after_state: null,
                correlation_id: null,
                key_id: null,
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

    const ev = await emitter.emit(input);

    expect(ev.id).toBe(existingId);
    expect(ev.eventHash).toBe(existingHashHex);
    expect(ev.prevEventHash).toBeNull();
    expect(ev.createdAt).toBe("2026-06-07T00:00:00.000Z");
    // It returned the existing row — NO new event was inserted.
    expect(log.some((s) => s.startsWith("INSERT"))).toBe(false);
    expect(log).toContain("COMMIT");
    expect(client.released).toBe(true);
  });

  it("throws audit_idempotency_conflict when the same key has a different payload", async () => {
    const createdAt = new Date("2026-06-07T00:00:00.000Z");
    const base = baseEvent();
    // The stored row's hash is for one payload; the caller emits a DIFFERENT one
    // (only `action` differs) under the same key. The recomputed hash will not
    // match the stored hash -> conflict, not a silent phantom return.
    const storedHash = Buffer.from(
      hashEvent({
        event: { ...base, action: "raw.ingest", idempotencyKey: "k1" },
        id: "evt_existing",
        createdAt: createdAt.toISOString(),
        prevEventHash: null,
      }),
      "hex",
    );
    const log: string[] = [];
    const client = {
      released: false,
      query: vi.fn(async (text: string) => {
        log.push(text.trim().split("\n")[0]!.trim());
        if (text.includes("idempotency_key = $2")) {
          return {
            rows: [
              {
                id: "evt_existing",
                event_hash: storedHash,
                prev_event_hash: null,
                created_at: createdAt,
                hash_schema_version: 2,
                layer: base.layer,
                actor: base.actor,
                action: "raw.ingest",
                inputs: base.inputs,
                outputs: base.outputs,
                policy_version: null,
                policy_decision_id: null,
                before_state: null,
                after_state: null,
                correlation_id: null,
                key_id: null,
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

    await expect(
      emitter.emit({ ...base, action: "raw.tombstone", idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "audit_idempotency_conflict" });

    // Read-only transaction rolled back; nothing written or committed.
    expect(log).toContain("ROLLBACK");
    expect(log).not.toContain("COMMIT");
    expect(log.some((s) => s.startsWith("INSERT"))).toBe(false);
    expect(client.released).toBe(true);
  });

  /** Build a fake pg client whose idempotency lookup returns one stored row. */
  function hitClient(over: Record<string, unknown>): {
    client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
    log: string[];
  } {
    const log: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        log.push(text.trim().split("\n")[0]!.trim());
        if (text.includes("idempotency_key = $2")) {
          return {
            rows: [
              {
                id: "evt_v0",
                event_hash: Buffer.from("cc".repeat(32), "hex"), // superseded hash, ignored for v0
                prev_event_hash: null,
                created_at: new Date("2026-06-07T00:00:00.000Z"),
                policy_version: null,
                policy_decision_id: null,
                before_state: null,
                after_state: null,
                ...over,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    return { client, log };
  }

  it("version-0 hit returns the existing event when logical fields match (no rehash)", async () => {
    const input: AuditEventInput = { ...baseEvent(), idempotencyKey: "k1" };
    const { client, log } = hitClient({
      hash_schema_version: 0,
      layer: input.layer,
      actor: input.actor,
      action: input.action,
      inputs: input.inputs,
      outputs: input.outputs,
    });
    const ev = await new PostgresAuditEmitter({
      connect: async () => client,
    } as unknown as Pool).emit(input);
    expect(ev.id).toBe("evt_v0");
    expect(log).toContain("COMMIT");
    expect(log.some((s) => s.startsWith("INSERT"))).toBe(false); // no false conflict, no duplicate
  });

  it("version-0 hit conflicts when logical fields differ", async () => {
    const input: AuditEventInput = { ...baseEvent(), idempotencyKey: "k1" };
    const { client } = hitClient({
      hash_schema_version: 0,
      layer: input.layer,
      actor: input.actor,
      action: "raw.tombstone", // differs from input.action
      inputs: input.inputs,
      outputs: input.outputs,
    });
    await expect(
      new PostgresAuditEmitter({ connect: async () => client } as unknown as Pool).emit(input),
    ).rejects.toMatchObject({ code: "audit_idempotency_conflict" });
  });

  it("fails closed on an unverifiable (unknown) hash_schema_version", async () => {
    const input: AuditEventInput = { ...baseEvent(), idempotencyKey: "k1" };
    const { client } = hitClient({ hash_schema_version: 99 });
    await expect(
      new PostgresAuditEmitter({ connect: async () => client } as unknown as Pool).emit(input),
    ).rejects.toMatchObject({ code: "audit_hash_version_unsupported" });
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
