/**
 * Minimal Merge (accounting category) API client for the authenticated pull
 * path. One aggregator connector unlocks QuickBooks, Xero, NetSuite, Sage,
 * and FreshBooks through Merge's normalized schema (ingestion architecture,
 * Appendix B case 2).
 *
 * Auth is two-part per Merge's convention: the platform API key as a Bearer
 * token plus the per-connection linked-account token in X-Account-Token.
 * Both come from the encrypted source credential store, resolved narrowly
 * per partition run.
 *
 * Deliberately thin (mirrors stripe-client.ts): responses are wrapped as
 * opaque artifacts; only the pagination controls (`next` cursor) and the
 * per-object `modified_at` watermark candidates are interpreted here.
 */

import { brainError } from "@brain/shared";

const MERGE_BASE_URL = "https://api.merge.dev/api/accounting/v1";

export interface MergeCredentials {
  apiKey: string;
  accountToken: string;
}

export interface MergeListPage {
  /** Verbatim response bytes — stored as the artifact body, never re-serialized. */
  body: Buffer;
  /** Merge `next` cursor; null when this is the last page. */
  nextCursor: string | null;
  /** Highest `modified_at` ISO timestamp on the page (watermark candidate). */
  maxModifiedAt: string | null;
  /** Number of objects on the page. */
  count: number;
}

async function mergeGet(
  creds: MergeCredentials,
  path: string,
  params: Record<string, string>,
): Promise<Buffer> {
  const qs = new URLSearchParams(params).toString();
  const url = `${MERGE_BASE_URL}${path}${qs.length > 0 ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${creds.apiKey}`,
      "x-account-token": creds.accountToken,
    },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw brainError("raw_source_unsupported", `Merge ${path} returned ${res.status}`, {
      statusOverride: 502,
      details: { path, status: res.status },
    });
  }
  return bytes;
}

/** One bounded page of a Merge list endpoint. */
export async function mergeListPage(
  creds: MergeCredentials,
  path: string,
  opts: { modifiedAfter?: string; cursor?: string; pageSize?: number },
): Promise<MergeListPage> {
  const params: Record<string, string> = { page_size: String(opts.pageSize ?? 100) };
  if (opts.modifiedAfter !== undefined) params["modified_after"] = opts.modifiedAfter;
  if (opts.cursor !== undefined) params["cursor"] = opts.cursor;

  const body = await mergeGet(creds, path, params);
  const parsed = JSON.parse(body.toString("utf8")) as {
    next?: string | null;
    results?: Array<{ modified_at?: string }>;
  };
  const results = parsed.results ?? [];
  // ISO-8601 UTC strings compare lexicographically.
  let maxModifiedAt: string | null = null;
  for (const r of results) {
    if (
      typeof r.modified_at === "string" &&
      (maxModifiedAt === null || r.modified_at > maxModifiedAt)
    ) {
      maxModifiedAt = r.modified_at;
    }
  }
  return {
    body,
    nextCursor: typeof parsed.next === "string" && parsed.next.length > 0 ? parsed.next : null,
    maxModifiedAt,
    count: results.length,
  };
}

/**
 * The linked account's underlying platform (e.g. "NetSuite") — kept visible
 * so the original source is never lost behind the aggregator (anti-pattern
 * list: "recording an aggregator while losing the original source").
 */
export async function mergeIntegrationName(creds: MergeCredentials): Promise<string> {
  const body = await mergeGet(creds, "/account-details", {});
  const parsed = JSON.parse(body.toString("utf8")) as { integration?: string };
  return typeof parsed.integration === "string" && parsed.integration.length > 0
    ? parsed.integration
    : "unknown";
}
