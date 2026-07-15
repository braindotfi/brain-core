/**
 * Minimal Stripe API client for the authenticated pull path.
 *
 * List endpoints only, plus GET /v1/account for connection identity.
 * Deliberately thin (mirrors plaid-client.ts): the adapter wraps responses
 * as opaque artifacts; beyond the pagination controls (`has_more`, object
 * ids, `created`) no response field is interpreted here, so parser changes
 * never require client changes.
 *
 * Auth: the tenant's restricted/secret key from the encrypted source
 * credential store, sent as a Bearer token per Stripe's API convention. The
 * key is resolved narrowly per partition run by the sync worker and never
 * persisted by the adapter.
 */

import { brainError } from "@brain/shared";

const STRIPE_BASE_URL = "https://api.stripe.com";

export interface StripeListPage {
  /** Verbatim response bytes — stored as the artifact body, never re-serialized. */
  body: Buffer;
  hasMore: boolean;
  /** Id of the last object on the page (Stripe `starting_after` cursor). */
  lastId: string | null;
  /** Highest `created` epoch seconds on the page (watermark candidate). */
  maxCreated: number | null;
  /** Number of objects on the page. */
  count: number;
}

async function stripeGet(
  apiKey: string,
  path: string,
  params: Record<string, string>,
): Promise<Buffer> {
  const qs = new URLSearchParams(params).toString();
  const url = `${STRIPE_BASE_URL}${path}${qs.length > 0 ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw brainError("raw_source_unsupported", `Stripe ${path} returned ${res.status}`, {
      statusOverride: 502,
      details: { path, status: res.status },
    });
  }
  return bytes;
}

/** One bounded page of a Stripe list endpoint. */
export async function stripeListPage(
  apiKey: string,
  path: string,
  opts: { createdGte?: number; startingAfter?: string; limit?: number },
): Promise<StripeListPage> {
  const params: Record<string, string> = { limit: String(opts.limit ?? 100) };
  if (opts.createdGte !== undefined) params["created[gte]"] = String(opts.createdGte);
  if (opts.startingAfter !== undefined) params["starting_after"] = opts.startingAfter;

  const body = await stripeGet(apiKey, path, params);
  const parsed = JSON.parse(body.toString("utf8")) as {
    data?: Array<{ id?: string; created?: number }>;
    has_more?: boolean;
  };
  const data = parsed.data ?? [];
  const last = data[data.length - 1];
  const createds = data
    .map((d) => d.created)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  return {
    body,
    hasMore: parsed.has_more === true,
    lastId: typeof last?.id === "string" ? last.id : null,
    maxCreated: createds.length > 0 ? Math.max(...createds) : null,
    count: data.length,
  };
}

/** The connected Stripe account's id (connection identity, captured once per checkpoint). */
export async function stripeAccountId(apiKey: string): Promise<string> {
  const body = await stripeGet(apiKey, "/v1/account", {});
  const parsed = JSON.parse(body.toString("utf8")) as { id?: string };
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw brainError("raw_source_unsupported", "Stripe /v1/account returned no account id", {
      statusOverride: 502,
    });
  }
  return parsed.id;
}
