/**
 * The HTTP transport — every API call funnels through this.
 *
 * Responsibilities:
 *   - Inject `Authorization: Bearer <apiKey>`
 *   - Inject `Idempotency-Key: <key>` on POST/PUT/PATCH/DELETE
 *   - Inject `Accept: application/json` and `Content-Type: application/json`
 *     for JSON requests
 *   - Parse JSON responses and throw a typed `BrainError` on non-2xx
 *   - Surface the response's `trace_id` (from body envelope) or
 *     `X-Brain-Trace-Id` header on every error
 *
 * @packageDocumentation
 */

import {
  BRAIN_ERROR_CLASS_BY_CODE,
  BrainError,
  brainErrorFromEnvelope,
  isBrainErrorEnvelope,
  type BrainErrorCode,
  type BrainErrorOptions,
} from "../errors/index.js";
import type { FetchLike } from "../index.js";
import { generateIdempotencyKey } from "./idempotency.js";

/** HTTP methods the transport recognizes. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const MUTATING_METHODS = new Set<HttpMethod>(["POST", "PUT", "PATCH", "DELETE"]);

/** Per-call options accepted by every transport method. */
export interface RequestOptions {
  /** Query parameters. Values are stringified; `undefined` is skipped. */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** JSON body (for POST/PUT/PATCH/DELETE). */
  readonly body?: unknown;
  /** Extra headers, merged after the SDK's defaults. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Caller-supplied idempotency key. When omitted, the SDK generates
   * one for mutating methods.
   */
  readonly idempotencyKey?: string;
  /** Abort signal for cancellation / timeout. */
  readonly signal?: AbortSignal;
}

/** Constructor options for `BrainHttp`. */
export interface BrainHttpOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: FetchLike;
  /**
   * User-Agent suffix appended to the SDK's own UA string. Useful for
   * customer/app identification on the Brain side.
   */
  readonly userAgent?: string;
}

const SDK_USER_AGENT = "brain-sdk-ts/0.1.0";

/**
 * The HTTP transport. One instance per `Brain` client.
 *
 * Public API surface is small on purpose: `get`, `post`, `put`,
 * `patch`, `del`, plus the generic `request`. Namespace modules build
 * on top of these.
 */
export class BrainHttp {
  readonly #baseUrl: string;
  /** Mutable so auth flows (SIWX) can swap the bearer mid-session. */
  #bearerToken: string;
  readonly #fetch: FetchLike;
  readonly #userAgent: string;

  public constructor(opts: BrainHttpOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#bearerToken = opts.apiKey;
    this.#fetch = opts.fetch;
    this.#userAgent = opts.userAgent ? `${SDK_USER_AGENT} ${opts.userAgent}` : SDK_USER_AGENT;
  }

  /**
   * Rotate the bearer token on this transport. After
   * `brain.auth.signInWithSIWX(...)` succeeds, subsequent requests
   * authenticate as the agent rather than with the initial api key.
   * Pass `null` to clear (sign-out).
   */
  public setBearerToken(token: string | null): void {
    this.#bearerToken = token ?? "";
  }

  /** Returns true when there is a non-empty bearer to send. */
  public hasBearerToken(): boolean {
    return this.#bearerToken.length > 0;
  }

  /** Generic request. Most callers use `get` / `post` / etc. instead. */
  public async request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers = this.buildHeaders(method, opts);

    const init: RequestInit = {
      method,
      headers,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (cause) {
      // Network-level failure (DNS, TCP, TLS, fetch threw). Surface
      // as upstream_timeout — the closest registered code — with the
      // original error chained as cause.
      throw new BrainError(
        "upstream_timeout",
        `network error contacting ${url}: ${stringifyError(cause)}`,
        { cause },
      );
    }

    return this.parseResponse<T>(response);
  }

  public get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, opts);
  }
  public post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }
  public put<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, { ...opts, body });
  }
  public patch<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  /** Name `del` (not `delete`) because `delete` is a reserved word. */
  public del<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    let url = `${this.#baseUrl}${normalized}`;
    if (query !== undefined) {
      const params: string[] = [];
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        params.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
      if (params.length > 0) url += `?${params.join("&")}`;
    }
    return url;
  }

  private buildHeaders(method: HttpMethod, opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.#bearerToken}`,
      "User-Agent": this.#userAgent,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (MUTATING_METHODS.has(method)) {
      headers["Idempotency-Key"] = opts.idempotencyKey ?? generateIdempotencyKey();
    }
    if (opts.headers !== undefined) {
      for (const [k, v] of Object.entries(opts.headers)) {
        headers[k] = v;
      }
    }
    return headers;
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    // 204 No Content — no body to parse.
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // Non-JSON body. For 2xx that's an SDK bug or contract
        // violation; for non-2xx we fall back to a synthetic error.
        if (response.ok) {
          throw new BrainError(
            "internal_error",
            `expected JSON response from ${response.url}, got: ${text.slice(0, 200)}`,
            { statusCode: response.status },
          );
        }
        throw synthesizeErrorFromStatus(response, text);
      }
    }

    if (response.ok) return body as T;

    // Non-2xx with a parsed body. Prefer the canonical envelope; fall
    // back to a synthetic error if the server returned non-conforming
    // JSON (e.g. a CDN error page).
    if (isBrainErrorEnvelope(body)) {
      throw brainErrorFromEnvelope(body, response.status);
    }
    throw synthesizeErrorFromStatus(response, text);
  }
}

/**
 * Build a sensible `BrainError` when the server returned non-2xx but
 * the body is not a Brain error envelope (e.g. proxy 502 from
 * Cloudflare, a load balancer's plain-text 504).
 */
function synthesizeErrorFromStatus(response: Response, bodySnippet: string): BrainError {
  const status = response.status;
  const headerTrace =
    response.headers.get("x-brain-trace-id") ?? response.headers.get("x-trace-id") ?? undefined;

  let code: BrainErrorCode;
  if (status === 401) code = "auth_invalid_key";
  else if (status === 403) code = "scope_insufficient";
  else if (status === 404) code = "tenant_not_found";
  else if (status === 408 || status === 504) code = "upstream_timeout";
  else if (status === 429) code = "rate_limited";
  else if (status === 503) code = "maintenance_mode";
  else code = "internal_error";

  const message = `HTTP ${status} from ${response.url}: ${bodySnippet.slice(0, 200) || response.statusText}`;
  const opts: BrainErrorOptions = {
    statusCode: status,
    ...(headerTrace !== undefined ? { traceId: headerTrace } : {}),
  };

  // Use the typed subclass when one exists for the code, so callers can
  // `instanceof RateLimitedError`. Falls back to base `BrainError` for
  // codes that have no dedicated subclass.
  const Cls = (
    BRAIN_ERROR_CLASS_BY_CODE as Record<
      string,
      new (m: string, o?: BrainErrorOptions) => BrainError
    >
  )[code];
  if (Cls !== undefined) return new Cls(message, opts);
  return new BrainError(code, message, opts);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
