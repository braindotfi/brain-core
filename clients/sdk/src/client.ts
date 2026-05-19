import createClient, { type Client } from "openapi-fetch";

import type { paths } from "./generated/openapi.js";

export interface BrainHttpClientOptions {
  /** JWT bearer token. Sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Resolved base URL (already stripped of trailing slash). */
  baseUrl?: string;
  /** Optional fetch implementation override (testing, custom transports). */
  fetch?: typeof globalThis.fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export type BrainHttpClient = Client<paths>;

export function createBrainHttpClient(options: BrainHttpClientOptions): BrainHttpClient {
  if (!options.token) {
    throw new Error("createBrainHttpClient: token is required");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };

  const clientOptions: Parameters<typeof createClient<paths>>[0] = {
    baseUrl: options.baseUrl ?? "https://api.brain.fi/v1",
    headers,
  };
  if (options.fetch) {
    clientOptions.fetch = options.fetch;
  }

  return createClient<paths>(clientOptions);
}
