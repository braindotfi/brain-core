/**
 * Minimal Finch API client for the authenticated payroll pull path.
 *
 * One aggregator connector covers Gusto, Rippling, ADP, and Deel. Endpoints
 * used: /employer/company (snapshot), /employer/directory (snapshot,
 * offset-paged), /employer/payment (pay runs in a date window), and
 * POST /employer/pay-statement (per-pay-run detail).
 *
 * Sensitive-data posture: this client deliberately never calls
 * /employer/individual (SSN, dob, residence). Directory rows carry name and
 * employment linkage only; pay statements carry compensation detail, which
 * lands ONLY as encrypted raw bytes — the extractor copies aggregates, never
 * per-field compensation (see ledger/extractors/finch.ts).
 *
 * Auth: the connection's access token as a Bearer token plus the pinned
 * Finch-API-Version header, resolved narrowly per partition run.
 */

import { brainError } from "@brain/shared";

const FINCH_BASE_URL = "https://api.tryfinch.com";
const FINCH_API_VERSION = "2020-09-17";

async function finchFetch(
  accessToken: string,
  path: string,
  init: { method?: string; params?: Record<string, string>; body?: unknown },
): Promise<Buffer> {
  const qs = init.params !== undefined ? `?${new URLSearchParams(init.params).toString()}` : "";
  const res = await fetch(`${FINCH_BASE_URL}${path}${qs}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "finch-api-version": FINCH_API_VERSION,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw brainError("raw_source_unsupported", `Finch ${path} returned ${res.status}`, {
      statusOverride: 502,
      details: { path, status: res.status },
    });
  }
  return bytes;
}

export interface FinchSnapshot {
  body: Buffer;
}

export interface FinchDirectoryPage {
  body: Buffer;
  /** Individuals on this page. */
  count: number;
  /** True when offset+count < total (another page exists). */
  hasMore: boolean;
}

export interface FinchPaymentsWindow {
  body: Buffer;
  /** Pay-run ids in the window (drives the pay-statement fetch). */
  paymentIds: string[];
}

export async function finchCompany(accessToken: string): Promise<FinchSnapshot> {
  return { body: await finchFetch(accessToken, "/employer/company", {}) };
}

export async function finchDirectoryPage(
  accessToken: string,
  offset: number,
  limit = 250,
): Promise<FinchDirectoryPage> {
  const body = await finchFetch(accessToken, "/employer/directory", {
    params: { offset: String(offset), limit: String(limit) },
  });
  const parsed = JSON.parse(body.toString("utf8")) as {
    individuals?: unknown[];
    paging?: { count?: number; offset?: number };
  };
  const count = parsed.individuals?.length ?? 0;
  const total = parsed.paging?.count ?? count;
  return { body, count, hasMore: offset + count < total };
}

export async function finchPayments(
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<FinchPaymentsWindow> {
  const body = await finchFetch(accessToken, "/employer/payment", {
    params: { start_date: startDate, end_date: endDate },
  });
  const parsed = JSON.parse(body.toString("utf8")) as Array<{ id?: string }> | unknown;
  const paymentIds = Array.isArray(parsed)
    ? parsed
        .map((p) => (p as { id?: string }).id)
        .filter((id): id is string => typeof id === "string")
    : [];
  return { body, paymentIds };
}

export async function finchPayStatements(
  accessToken: string,
  paymentIds: string[],
): Promise<FinchSnapshot> {
  const body = await finchFetch(accessToken, "/employer/pay-statement", {
    method: "POST",
    body: { requests: paymentIds.map((payment_id) => ({ payment_id })) },
  });
  return { body };
}
