import createClient, { type Client } from "openapi-fetch";

import type { paths } from "./generated/openapi.js";

export interface BrainHttpClientOptions {
  /** Brain API key. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** API base URL. Defaults to the production server in the OpenAPI spec. */
  baseUrl?: string;
  /** Optional fetch implementation override (testing, custom transports). */
  fetch?: typeof globalThis.fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export type BrainHttpClient = Client<paths>;

const DEFAULT_BASE_URL = "https://api.brain.fi/v1";

export function createBrainHttpClient(options: BrainHttpClientOptions): BrainHttpClient {
  if (!options.apiKey) {
    throw new Error("createBrainHttpClient: apiKey is required");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };

  const clientOptions: Parameters<typeof createClient<paths>>[0] = {
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    headers,
  };
  if (options.fetch) {
    clientOptions.fetch = options.fetch;
  }

  return createClient<paths>(clientOptions);
}
