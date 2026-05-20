/**
 * Plaid webhook JWKS key resolver.
 *
 * Plaid signs webhooks with a JWT whose `kid` identifies the signing key.
 * The key is fetched from Plaid's verification endpoint on first use and
 * cached in-memory by `kid`. Plaid rotates keys infrequently (annually),
 * so a miss that triggers a re-fetch is the exception, not the rule.
 *
 * Plaid environments: sandbox | development | production — selected via
 * PLAID_ENV (shared config, already wired).
 */

import type { JWK } from "jose";

const PLAID_BASE_URLS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

export interface PlaidJwksOptions {
  clientId: string;
  secret: string;
  env: "sandbox" | "development" | "production";
}

export function createPlaidKeyResolver(
  opts: PlaidJwksOptions,
): (kid: string) => Promise<JWK> {
  const cache = new Map<string, JWK>();
  const baseUrl = PLAID_BASE_URLS[opts.env] ?? PLAID_BASE_URLS["sandbox"];

  async function fetchKey(kid: string): Promise<JWK> {
    const res = await fetch(`${baseUrl}/webhook_verification_key/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: opts.clientId,
        secret: opts.secret,
        key_id: kid,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`Plaid JWKS fetch failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { key?: JWK; request_id?: string };
    if (data.key === undefined) {
      throw new Error(`Plaid JWKS response missing 'key' field for kid=${kid}`);
    }
    return data.key;
  }

  return async function resolveKey(kid: string): Promise<JWK> {
    const cached = cache.get(kid);
    if (cached !== undefined) return cached;

    const key = await fetchKey(kid);
    cache.set(kid, key);
    return key;
  };
}
