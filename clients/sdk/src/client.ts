import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./generated/openapi.js";

export interface BrainHttpClientOptions {
  /** JWT bearer token. Sent as `Authorization: Bearer <token>`. Exactly one of `token`/`apiKey` is required. */
  token?: string;
  /**
   * Brain API key (`brain_sk_...`). Sent directly as
   * `Authorization: Bearer <apiKey>`. Exactly one of `token`/`apiKey` is
   * required.
   */
  apiKey?: string;
  /** Resolved base URL (already stripped of trailing slash). */
  baseUrl?: string;
  /** Optional fetch implementation override (testing, custom transports). */
  fetch?: typeof globalThis.fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export type BrainHttpClient = Client<paths>;

export function createBrainHttpClient(options: BrainHttpClientOptions): BrainHttpClient {
  if (options.token && options.apiKey) {
    throw new Error("createBrainHttpClient: pass exactly one of `token` or `apiKey`, not both");
  }
  if (!options.token && !options.apiKey) {
    throw new Error(
      "createBrainHttpClient: token is required (pass a JWT string), or pass apiKey instead",
    );
  }

  const baseUrl = options.baseUrl ?? "https://api.brain.fi/v1";
  const headers: Record<string, string> = {
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    ...(options.headers ?? {}),
  };

  const clientOptions: Parameters<typeof createClient<paths>>[0] = { baseUrl, headers };
  if (options.fetch) {
    clientOptions.fetch = options.fetch;
  }
  return createClient<paths>(clientOptions);
}
