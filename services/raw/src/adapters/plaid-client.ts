/**
 * Minimal Plaid API client for the authenticated pull path.
 *
 * Two endpoints only: `transactions/sync` (cursor deltas) and
 * `accounts/balance/get` (snapshot). Deliberately thin — the adapter wraps
 * responses as opaque artifacts; no response field is interpreted beyond the
 * cursor/pagination controls, so parser changes never require client changes.
 */

import { brainError } from "@brain/shared";

const PLAID_BASE_URLS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

export interface PlaidClientConfig {
  clientId: string;
  secret: string;
  baseUrl: string;
}

export interface PlaidTransactionsSyncPage {
  /** Verbatim response bytes — stored as the artifact body, never re-serialized. */
  body: Buffer;
  nextCursor: string;
  hasMore: boolean;
}

export interface PlaidBalanceSnapshot {
  body: Buffer;
}

/**
 * Resolve Plaid API credentials; null when the pull path is unconfigured.
 * Reads the three PLAID_* vars directly rather than via loadConfig(): the
 * full config schema requires DATABASE_URL etc., which an adapter must not
 * demand of its process. The same vars are declared in shared/src/config.ts
 * for documentation and validation at api boot.
 */
export function plaidClientConfig(
  env: Record<string, string | undefined> = process.env,
): PlaidClientConfig | null {
  const clientId = env["PLAID_CLIENT_ID"];
  const secret = env["PLAID_SECRET"];
  if (clientId === undefined || clientId === "" || secret === undefined || secret === "") {
    return null;
  }
  const baseUrl = PLAID_BASE_URLS[env["PLAID_ENV"] ?? "sandbox"] ?? PLAID_BASE_URLS["sandbox"]!;
  return { clientId, secret, baseUrl };
}

async function plaidPost(
  cfg: PlaidClientConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<Buffer> {
  const res = await fetch(`${cfg.baseUrl}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw brainError("raw_source_unsupported", `Plaid ${path} returned ${res.status}`, {
      statusOverride: 502,
      details: { path, status: res.status },
    });
  }
  return bytes;
}

/** One bounded `transactions/sync` page behind `cursor` (null = backfill start). */
export async function transactionsSyncPage(
  cfg: PlaidClientConfig,
  accessToken: string,
  cursor: string | null,
  count = 100,
): Promise<PlaidTransactionsSyncPage> {
  const body = await plaidPost(cfg, "transactions/sync", {
    access_token: accessToken,
    ...(cursor !== null ? { cursor } : {}),
    count,
  });
  const parsed = JSON.parse(body.toString("utf8")) as {
    next_cursor?: string;
    has_more?: boolean;
  };
  if (typeof parsed.next_cursor !== "string") {
    throw brainError("raw_source_unsupported", "Plaid transactions/sync returned no next_cursor", {
      statusOverride: 502,
    });
  }
  return { body, nextCursor: parsed.next_cursor, hasMore: parsed.has_more === true };
}

/** Full balance snapshot for the item. */
export async function balanceSnapshot(
  cfg: PlaidClientConfig,
  accessToken: string,
): Promise<PlaidBalanceSnapshot> {
  const body = await plaidPost(cfg, "accounts/balance/get", { access_token: accessToken });
  return { body };
}
