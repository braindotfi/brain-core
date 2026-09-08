import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./generated/openapi.js";
import { createAgentAuthenticatedFetch, DEFAULT_AGENT_TOKEN_URL } from "./agent-api-key.js";

export interface BrainHttpClientOptions {
  /** JWT bearer token. Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * Brain API key (`brain_sk_...`). Sent directly as
   * `Authorization: Bearer <apiKey>`.
   */
  apiKey?: string;
  /** Exchange-only agent credential (`brain_ak_...`). Never sent to resource routes. */
  agentApiKey?: string;
  /** Authorization-server token endpoint. Used only with `agentApiKey`. */
  tokenUrl?: string;
  /** RFC 8707 resource and JWT audience. Defaults to the API base URL origin. */
  resource?: string;
  /** Optional scope narrowing for the exchanged token. */
  agentScope?: string;
  /** Resolved base URL (already stripped of trailing slash). */
  baseUrl?: string;
  /** Optional fetch implementation override (testing, custom transports). */
  fetch?: typeof globalThis.fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export type BrainHttpClient = Client<paths> & { ready(): Promise<void> };

export function createBrainHttpClient(options: BrainHttpClientOptions): BrainHttpClient {
  const credentialCount = [options.token, options.apiKey, options.agentApiKey].filter(
    (value) => typeof value === "string" && value.length > 0,
  ).length;
  if (credentialCount > 1) {
    throw new Error(
      "createBrainHttpClient: pass exactly one of `token`, `apiKey`, or `agentApiKey`",
    );
  }
  if (credentialCount === 0) {
    throw new Error(
      "createBrainHttpClient: token is required (pass a JWT string), or pass apiKey or agentApiKey instead",
    );
  }

  const baseUrl = options.baseUrl ?? "https://api.brain.fi/v1";
  const headers: Record<string, string> = {
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    ...(options.headers ?? {}),
  };

  const clientOptions: Parameters<typeof createClient<paths>>[0] = { baseUrl, headers };
  let ready = async (): Promise<void> => {};
  if (options.agentApiKey) {
    const baseFetch = options.fetch ?? globalThis.fetch;
    if (typeof baseFetch !== "function") {
      throw new Error("createBrainHttpClient: no fetch implementation available");
    }
    const resource = options.resource ?? `${new URL(baseUrl).origin}/`;
    const agentAuth = createAgentAuthenticatedFetch({
      agentApiKey: options.agentApiKey,
      tokenUrl: options.tokenUrl ?? DEFAULT_AGENT_TOKEN_URL,
      resource,
      ...(options.agentScope !== undefined ? { scope: options.agentScope } : {}),
      fetch: baseFetch,
    });
    clientOptions.fetch = agentAuth.fetch;
    ready = agentAuth.ready;
  } else if (options.fetch) {
    clientOptions.fetch = options.fetch;
  }
  const client = createClient<paths>(clientOptions) as BrainHttpClient;
  Object.defineProperty(client, "ready", { value: ready, enumerable: false });
  return client;
}
