/**
 * Client-side idempotency key generation.
 *
 * The SDK injects `Idempotency-Key: <key>` on every mutating call
 * (POST/PUT/PATCH/DELETE). Callers may supply their own via the
 * `idempotencyKey` option; otherwise we generate one here.
 *
 * Format: `idem_<uuid-v4-no-hyphens>`. UUID-v4 gives 122 bits of
 * entropy, which is plenty for at-least-once delivery dedup; the
 * `idem_` prefix is for readability in logs and dashboards.
 *
 * @packageDocumentation
 */

const IDEMPOTENCY_PREFIX = "idem_";

/**
 * Cached reference to `globalThis.crypto.randomUUID`. Resolved lazily
 * because some runtimes patch `globalThis.crypto` after module load.
 */
function getRandomUUID(): () => string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID !== undefined && typeof crypto.randomUUID === "function") {
    // Bind so call sites work without `this` shenanigans.
    return crypto.randomUUID.bind(crypto);
  }
  throw new Error(
    "@brain/sdk: globalThis.crypto.randomUUID is not available. " +
      "Upgrade to Node 18.17+, Bun, Deno, or a modern browser/edge runtime, " +
      "or supply your own `idempotencyKey` per call.",
  );
}

/**
 * Generate a fresh idempotency key.
 *
 * @example
 * generateIdempotencyKey() // "idem_d2f8e7c4a91b4e9388fc7a0d1234567"
 */
export function generateIdempotencyKey(): string {
  const uuid = getRandomUUID()();
  return `${IDEMPOTENCY_PREFIX}${uuid.replace(/-/g, "")}`;
}

/**
 * Returns true if `s` could plausibly be a Brain-generated idempotency
 * key. Permissive — accepts any non-empty string with the `idem_`
 * prefix. Callers may supply arbitrary string keys, so do not use this
 * for validation of caller-supplied values.
 */
export function looksLikeIdempotencyKey(s: string): boolean {
  return s.startsWith(IDEMPOTENCY_PREFIX) && s.length > IDEMPOTENCY_PREFIX.length;
}
