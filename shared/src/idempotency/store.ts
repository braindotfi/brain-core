/**
 * Brain idempotency store.
 *
 * §5.1:
 *   - Explicit idempotency keys are scoped to the tenant.
 *   - TTL 24 hours in Redis.
 *   - A request with a key matching a completed request returns the stored response.
 *   - A request with a key matching an in-flight request returns 409.
 *
 * §5.3 (smart contract writes): idempotent by signing-account nonce + canonical
 * tx hash — lives in the execution service; not this store's concern.
 *
 * Key shape: `idemp:<tenantId>:<key>`
 * Value shape:
 *   - in-flight: JSON `{ state: "in_flight", body_hash, started_at }`
 *   - done:      JSON `{ state: "done", body_hash, status, body }`
 *
 * Distinction: body_hash is included so a caller who reuses a key with a
 * *different* body gets a 409 (execution_idempotency_conflict) rather than
 * silently receiving someone else's stored response.
 */

import { createHash } from "node:crypto";
import type { Redis } from "ioredis";

export interface StoredResponse {
  status: number;
  /** JSON body as serialized string — rehydrate at the caller. */
  body: string;
}

export type IdempotencyLookup =
  | { state: "miss" }
  | { state: "in_flight"; bodyHash: string }
  | { state: "done"; bodyHash: string; response: StoredResponse }
  | { state: "conflict"; storedBodyHash: string; suppliedBodyHash: string };

export interface IdempotencyStore {
  /**
   * Probe for an existing entry AND record an in-flight marker atomically.
   * Returns:
   *   - "miss":      no prior entry; marker now written. Caller proceeds.
   *   - "done":      prior completed entry; caller returns stored response.
   *   - "in_flight": prior concurrent request still running; caller returns 409.
   *   - "conflict":  prior entry exists with a DIFFERENT body hash; caller
   *                  returns execution_idempotency_conflict.
   */
  probeAndMark(input: {
    tenantId: string;
    key: string;
    bodyHash: string;
    ttlSeconds: number;
  }): Promise<IdempotencyLookup>;

  /** Replace the in-flight marker with a done entry carrying the response. */
  complete(input: {
    tenantId: string;
    key: string;
    bodyHash: string;
    response: StoredResponse;
    ttlSeconds: number;
  }): Promise<void>;

  /** Delete the in-flight marker after a failed handler so retries can proceed. */
  discard(input: { tenantId: string; key: string }): Promise<void>;
}

export function idempotencyRedisKey(tenantId: string, key: string): string {
  return `idemp:${tenantId}:${key}`;
}

export function hashBody(body: Uint8Array | string): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Redis-backed store.
 *
 * The probe-and-mark is a GET-then-SET dance. We use SET NX to make the mark
 * atomic — if a concurrent request races us, one wins, the other sees the
 * marker as an "in_flight" entry on its own GET. The GET-SET is not a single
 * CAS, but the ordering (GET first, SET NX second) means:
 *   - Miss path writes our in-flight marker with NX.
 *   - Race where two requests see "miss": exactly one SET NX wins; the loser
 *     proceeds to re-GET and sees "in_flight".
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  public constructor(private readonly redis: Redis) {}

  public async probeAndMark(input: {
    tenantId: string;
    key: string;
    bodyHash: string;
    ttlSeconds: number;
  }): Promise<IdempotencyLookup> {
    const k = idempotencyRedisKey(input.tenantId, input.key);
    const existing = await this.redis.get(k);
    if (existing !== null) {
      return interpretExisting(existing, input.bodyHash);
    }
    const marker = JSON.stringify({
      state: "in_flight",
      body_hash: input.bodyHash,
      started_at: new Date().toISOString(),
    });
    const ok = await this.redis.set(k, marker, "EX", input.ttlSeconds, "NX");
    if (ok === null) {
      // Race: another request wrote a marker between our GET and SET.
      const again = await this.redis.get(k);
      if (again !== null) {
        return interpretExisting(again, input.bodyHash);
      }
      // Extremely unlikely: entry vanished (e.g. FLUSHDB). Treat as miss.
      return { state: "miss" };
    }
    return { state: "miss" };
  }

  public async complete(input: {
    tenantId: string;
    key: string;
    bodyHash: string;
    response: StoredResponse;
    ttlSeconds: number;
  }): Promise<void> {
    const k = idempotencyRedisKey(input.tenantId, input.key);
    const done = JSON.stringify({
      state: "done",
      body_hash: input.bodyHash,
      status: input.response.status,
      body: input.response.body,
    });
    await this.redis.set(k, done, "EX", input.ttlSeconds);
  }

  public async discard(input: { tenantId: string; key: string }): Promise<void> {
    const k = idempotencyRedisKey(input.tenantId, input.key);
    await this.redis.del(k);
  }
}

function interpretExisting(raw: string, suppliedBodyHash: string): IdempotencyLookup {
  let parsed: {
    state?: string;
    body_hash?: string;
    status?: number;
    body?: string;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // Corrupted entry — treat as miss so retries can proceed cleanly.
    return { state: "miss" };
  }
  const storedHash = parsed.body_hash ?? "";
  if (
    parsed.state === "done" &&
    typeof parsed.status === "number" &&
    typeof parsed.body === "string"
  ) {
    if (storedHash !== suppliedBodyHash) {
      return { state: "conflict", storedBodyHash: storedHash, suppliedBodyHash };
    }
    return {
      state: "done",
      bodyHash: storedHash,
      response: { status: parsed.status, body: parsed.body },
    };
  }
  if (parsed.state === "in_flight") {
    if (storedHash !== suppliedBodyHash) {
      return { state: "conflict", storedBodyHash: storedHash, suppliedBodyHash };
    }
    return { state: "in_flight", bodyHash: storedHash };
  }
  return { state: "miss" };
}

// ---------------------------------------------------------------------------
// In-memory test double
// ---------------------------------------------------------------------------

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { raw: string; expiresAt: number }>();

  private prune(now: number): void {
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= now) this.entries.delete(k);
    }
  }

  public async probeAndMark(input: {
    tenantId: string;
    key: string;
    bodyHash: string;
    ttlSeconds: number;
  }): Promise<IdempotencyLookup> {
    const now = Date.now();
    this.prune(now);
    const k = idempotencyRedisKey(input.tenantId, input.key);
    const existing = this.entries.get(k);
    if (existing !== undefined) {
      return interpretExisting(existing.raw, input.bodyHash);
    }
    const marker = JSON.stringify({
      state: "in_flight",
      body_hash: input.bodyHash,
      started_at: new Date(now).toISOString(),
    });
    this.entries.set(k, { raw: marker, expiresAt: now + input.ttlSeconds * 1000 });
    return { state: "miss" };
  }

  public async complete(input: {
    tenantId: string;
    key: string;
    bodyHash: string;
    response: StoredResponse;
    ttlSeconds: number;
  }): Promise<void> {
    const k = idempotencyRedisKey(input.tenantId, input.key);
    const done = JSON.stringify({
      state: "done",
      body_hash: input.bodyHash,
      status: input.response.status,
      body: input.response.body,
    });
    this.entries.set(k, {
      raw: done,
      expiresAt: Date.now() + input.ttlSeconds * 1000,
    });
  }

  public async discard(input: { tenantId: string; key: string }): Promise<void> {
    this.entries.delete(idempotencyRedisKey(input.tenantId, input.key));
  }
}
