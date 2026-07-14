import createClient, { type Client, type Middleware } from "openapi-fetch";

import { BrainAPIError, type BrainErrorBody } from "./errors.js";
import type { paths } from "./generated/openapi.js";

export interface BrainHttpClientOptions {
  /** JWT bearer token. Sent as `Authorization: Bearer <token>`. Exactly one of `token`/`apiKey` is required. */
  token?: string;
  /**
   * Brain API key (`brain_sk_...`). Exchanged lazily for a short-lived bearer
   * token via `POST {baseUrl}/auth/api-key`, cached, and auto-refreshed on
   * expiry or a 401. Exactly one of `token`/`apiKey` is required.
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

/** Refresh this long before the cached token's `expires_in` to avoid racing expiry mid-request. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

interface ApiKeyExchangeResponse {
  token: string;
  token_type: string;
  expires_in: number;
  tenant_id: string;
  agent_id: string;
  scopes: string[];
}

function apiKeyError(status: number, body: BrainErrorBody | undefined, fallbackMessage: string): BrainAPIError {
  return new BrainAPIError(
    status,
    body ?? {
      error: {
        code: status === 404 ? "not_found" : status === 0 ? "network_error" : "auth_header_invalid",
        message: fallbackMessage,
        request_id: "",
        docs_url: "https://docs.brain.fi/resources/errors",
      },
    },
  );
}

/**
 * Builds the `onRequest`/`onResponse` middleware pair that turns a Brain API
 * key into bearer tokens on demand: exchanges lazily on first use (with
 * concurrent callers sharing one in-flight exchange), caches the result
 * until ~60s before `expires_in`, and — on a 401 — invalidates the cache,
 * re-exchanges once, and retries the original request exactly once.
 */
function createApiKeyMiddleware(
  apiKey: string,
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch,
): Middleware {
  let cached: { token: string; expiresAtMs: number } | undefined;
  let inflight: Promise<string> | undefined;
  // Request clones taken pre-fetch (bodies aren't consumable post-fetch), keyed by
  // openapi-fetch's per-request id, so a 401 can be retried with a fresh token.
  const pendingClones = new Map<string, Request>();
  const retriedIds = new Set<string>();

  async function exchange(): Promise<string> {
    if (!inflight) {
      inflight = (async () => {
        let res: Response;
        try {
          res = await fetchImpl(`${baseUrl}/auth/api-key`, {
            method: "POST",
            headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
            body: "{}",
          });
        } catch (cause) {
          throw apiKeyError(
            0,
            undefined,
            `Brain: failed to reach ${baseUrl}/auth/api-key to exchange the API key: ${String(cause)}`,
          );
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => undefined)) as BrainErrorBody | undefined;
          if (res.status === 404) {
            throw apiKeyError(
              404,
              body,
              "Brain: POST /auth/api-key returned 404 — API-key auth is not enabled on this " +
                "Brain deployment. Pass a bearer `token` instead, or enable the feature on the server.",
            );
          }
          throw apiKeyError(
            res.status,
            body,
            "Brain: API-key exchange was rejected — the key is invalid, revoked, or expired.",
          );
        }
        const data = (await res.json()) as ApiKeyExchangeResponse;
        cached = { token: data.token, expiresAtMs: Date.now() + data.expires_in * 1000 };
        return data.token;
      })().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  }

  async function getToken(forceRefresh: boolean): Promise<string> {
    if (forceRefresh) {
      cached = undefined;
    } else if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return cached.token;
    }
    return exchange();
  }

  return {
    async onRequest({ request, id }) {
      pendingClones.set(id, request.clone());
      request.headers.set("Authorization", `Bearer ${await getToken(false)}`);
      return request;
    },
    async onResponse({ response, id }) {
      const retryRequest = pendingClones.get(id);
      pendingClones.delete(id);
      if (response.status !== 401 || retriedIds.has(id) || !retryRequest) {
        return undefined;
      }
      retriedIds.add(id);
      retryRequest.headers.set("Authorization", `Bearer ${await getToken(true)}`);
      return fetchImpl(retryRequest);
    },
  };
}

export function createBrainHttpClient(options: BrainHttpClientOptions): BrainHttpClient {
  if (options.token && options.apiKey) {
    throw new Error("createBrainHttpClient: pass exactly one of `token` or `apiKey`, not both");
  }
  if (!options.token && !options.apiKey) {
    throw new Error("createBrainHttpClient: token is required (pass a JWT string), or pass apiKey instead");
  }

  const baseUrl = options.baseUrl ?? "https://api.brain.fi/v1";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers ?? {}),
  };

  const clientOptions: Parameters<typeof createClient<paths>>[0] = { baseUrl, headers };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (options.fetch) {
    clientOptions.fetch = options.fetch;
  }

  const client = createClient<paths>(clientOptions);
  if (options.apiKey) {
    client.use(createApiKeyMiddleware(options.apiKey, baseUrl, fetchImpl));
  }
  return client;
}
