import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { operations } from "../generated/openapi.js";

export type YieldVenuesResult =
  operations["listYieldVenues"]["responses"]["200"]["content"]["application/json"];

/**
 * `GET /reference/yield-venues`, public, always-on, rate-limited (60/min),
 * `skipAuth: true` server-side. Same catalog for every tenant, no truth or
 * provenance coupling, not Ledger data. Like `AuthResource`, this talks to
 * the API directly over `fetch`/`baseUrl` rather than through the
 * token-authenticated `BrainHttpClient`, since no credential is required or
 * even accepted here. Also exposed as `brain.reference` on a regular
 * `new Brain(...)` instance, but that constructor itself requires a
 * token/apiKey; use `Brain.public(...)` to reach this before you hold one.
 */
export class ReferenceResource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  async yieldVenues(): Promise<YieldVenuesResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/reference/yield-venues`);
    const json = (await res.json().catch(() => undefined)) as
      | (YieldVenuesResult & { error?: undefined })
      | BrainErrorBody
      | undefined;
    if (!res.ok || json === undefined || json === null || "error" in json) {
      throw new BrainAPIError(res.status, json as BrainErrorBody | undefined);
    }
    return json;
  }
}
