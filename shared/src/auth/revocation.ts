/**
 * Brain JWT revocation cache.
 *
 * §3.1: "Revoked jti values are cached in Redis for the remainder of their
 * original expiry window." Short-lived tokens (15 min) mean the worst-case
 * revoked-but-still-valid window is bounded by token lifetime. The cache
 * exists to close that window intentionally when a user/agent logs out or
 * when an on-chain revocation lands for an external agent.
 */

import type { Redis } from "ioredis";

export interface RevocationStore {
  /**
   * Check whether a token's `jti` has been revoked.
   * Returns true iff the jti is present in the revocation set.
   */
  isRevoked(jti: string): Promise<boolean>;

  /**
   * Mark a token revoked until its original exp (epoch seconds).
   * Key TTL is computed so the entry self-evicts when the token would have
   * expired anyway — no cleanup job needed.
   */
  revoke(jti: string, expiresAtEpochSeconds: number): Promise<void>;
}

export function redisRevocationKey(jti: string): string {
  return `auth:revoked:${jti}`;
}

/**
 * Redis-backed implementation. Uses a single key per jti with a computed TTL
 * rather than a set — cheap per-jti lookup and automatic cleanup.
 */
export class RedisRevocationStore implements RevocationStore {
  public constructor(private readonly redis: Redis) {}

  public async isRevoked(jti: string): Promise<boolean> {
    const v = await this.redis.get(redisRevocationKey(jti));
    return v !== null;
  }

  public async revoke(jti: string, expiresAtEpochSeconds: number): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = Math.max(1, expiresAtEpochSeconds - nowSeconds);
    await this.redis.set(redisRevocationKey(jti), "1", "EX", ttl);
  }
}

/** Test helper — in-memory implementation that mirrors the Redis one. */
export class InMemoryRevocationStore implements RevocationStore {
  private readonly entries = new Map<string, number>(); // jti → expiry (seconds)

  public async isRevoked(jti: string): Promise<boolean> {
    const exp = this.entries.get(jti);
    if (exp === undefined) return false;
    if (Math.floor(Date.now() / 1000) > exp) {
      this.entries.delete(jti);
      return false;
    }
    return true;
  }

  public async revoke(jti: string, expiresAtEpochSeconds: number): Promise<void> {
    this.entries.set(jti, expiresAtEpochSeconds);
  }
}
