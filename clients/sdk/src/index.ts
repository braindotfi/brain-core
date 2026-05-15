/**
 * `@brain/sdk` — the official TypeScript SDK for the Brain Finance API.
 *
 * Source of truth: https://docs.brain.fi. Every public method, type, and
 * error code in this package maps 1:1 to a page on docs.brain.fi. The
 * cross-reference is `docs/sdk-audit.md` at the repo root.
 *
 * @packageDocumentation
 */

import { BrainHttp } from "./http/index.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Environment-specific defaults. The SDK ships with two named environments
 * matching the Brain Console (https://console.brain.fi and
 * https://console.brain.dev). Override `baseUrl` on the constructor if your
 * deployment uses a different host.
 */
export type BrainEnvironment = "production" | "sandbox";

/** Canonical base URLs per environment. */
export const BRAIN_BASE_URLS: Readonly<Record<BrainEnvironment, string>> = {
  production: "https://api.brain.fi/v1",
  sandbox: "https://api.brain.dev/v1",
};

/**
 * Minimal `fetch` signature the SDK requires. Compatible with the WHATWG
 * fetch standard and with `undici`'s fetch. Keeping it minimal so callers
 * can plug in mocks without satisfying the full lib.dom Request/Response
 * surface.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Constructor options for the `Brain` client.
 *
 * Per the canonical docs at
 * https://docs.brain.fi/sdks/quickstart, the minimum shape is
 * `{ apiKey }`. Everything else is optional.
 */
export interface BrainOptions {
  /**
   * Server key issued by the Brain Console.
   * Sandbox keys start with `brain_sk_test_`, production with
   * `brain_sk_live_`. Never expose a server key to the browser.
   */
  readonly apiKey: string;

  /**
   * Which environment to target. Defaults to `"production"`.
   * @see BRAIN_BASE_URLS
   */
  readonly environment?: BrainEnvironment;

  /**
   * Explicit base URL override. When set, takes precedence over
   * `environment`. Include the `/v1` path prefix.
   */
  readonly baseUrl?: string;

  /**
   * Custom `fetch` implementation. Defaults to `globalThis.fetch` when
   * present. Pass a runtime-appropriate fetch in environments that don't
   * have a global (some older Node versions, certain test harnesses).
   */
  readonly fetch?: FetchLike;

  /**
   * Optional SIWX signer for external-agent authentication flows
   * (`brain.auth.signInWithSIWX()`). When absent, only server-key flows
   * are available. Type is intentionally placeholder until the SIWX
   * commit lands — see plan item #15 in docs/sdk-audit.md.
   */
  readonly agentSigner?: unknown;

  /**
   * If set, methods that take a `tenantId` will fall back to this value
   * when the caller does not supply one. Useful for single-tenant apps.
   */
  readonly defaultTenantId?: string;
}

/**
 * Resolves the effective base URL from the supplied options.
 *
 * Precedence: explicit `baseUrl` > `environment` mapping > production
 * default.
 *
 * @internal
 */
export function resolveBaseUrl(opts: BrainOptions): string {
  if (opts.baseUrl !== undefined) return opts.baseUrl;
  const env: BrainEnvironment = opts.environment ?? "production";
  return BRAIN_BASE_URLS[env];
}

// ---------------------------------------------------------------------------
// Brain client
// ---------------------------------------------------------------------------

/**
 * The top-level Brain client. Construct one per tenant or one per
 * application (calls accept `tenantId` per-call).
 *
 * The class surfaces two APIs in parallel:
 *
 * 1. **Convenience methods** (positional `tenantId` first arg): `ask`,
 *    `pay`, `approve`, `reject`, `proof`, `trace`, `snapshot`. These
 *    are the "everyday" methods documented on docs.brain.fi/build/*.
 * 2. **Namespace methods** (object args): `brain.wiki.question(...)`,
 *    `brain.policy.create(...)`, etc. These mirror the OpenAPI surface
 *    1:1 and are the structured way to use the SDK from larger apps.
 *    See docs.brain.fi/sdks/* for each namespace.
 *
 * Implementations land in subsequent commits — this is the skeleton.
 */
export class Brain {
  /** Resolved base URL (no trailing slash). */
  public readonly baseUrl: string;

  /** Default tenant for calls that omit `tenantId`. */
  public readonly defaultTenantId: string | undefined;

  /**
   * The HTTP transport. Public for advanced/escape-hatch use cases —
   * most callers use the namespace methods.
   */
  public readonly http: BrainHttp;

  /** The api key. Kept readonly + non-public for safety. */
  readonly #apiKey: string;

  /** The fetch implementation used by the HTTP transport. */
  readonly #fetch: FetchLike;

  public constructor(opts: BrainOptions) {
    if (!opts.apiKey || typeof opts.apiKey !== "string") {
      throw new Error(
        "@brain/sdk: `apiKey` is required and must be a non-empty string. " +
          "Get one from https://console.brain.fi (production) or " +
          "https://console.brain.dev (sandbox).",
      );
    }
    this.#apiKey = opts.apiKey;
    this.baseUrl = resolveBaseUrl(opts).replace(/\/+$/, "");
    this.defaultTenantId = opts.defaultTenantId;

    const fetchImpl =
      opts.fetch ??
      (typeof globalThis.fetch === "function"
        ? (globalThis.fetch.bind(globalThis) as FetchLike)
        : undefined);
    if (fetchImpl === undefined) {
      throw new Error(
        "@brain/sdk: no `fetch` implementation found. " +
          "Pass `{ fetch }` to the Brain constructor in runtimes without a global fetch.",
      );
    }
    this.#fetch = fetchImpl;

    this.http = new BrainHttp({
      baseUrl: this.baseUrl,
      apiKey: this.#apiKey,
      fetch: this.#fetch,
    });
  }

  /**
   * The configured api key, masked. Returns `"brain_sk_***"` rather than
   * leaking the key. Use sparingly — this exists for diagnostic UI.
   */
  public getMaskedApiKey(): string {
    const k = this.#apiKey;
    if (k.length <= 11) return "***";
    return `${k.slice(0, 11)}***`;
  }

  /**
   * Access to the underlying fetch (for advanced cases — e.g. retries,
   * streaming endpoints not yet wrapped). Most callers should not need
   * this.
   *
   * @internal
   */
  public getFetch(): FetchLike {
    return this.#fetch;
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  BRAIN_ERROR_CODES,
  BRAIN_ERROR_CLASS_BY_CODE,
  BrainError,
  brainErrorFromEnvelope,
  isBrainError,
  isBrainErrorCode,
  isBrainErrorEnvelope,
  type BrainErrorCode,
  type BrainErrorEnvelope,
  type BrainErrorOptions,
  // Auth
  AuthInvalidKeyError,
  AuthExpiredError,
  AuthSiwxInvalidError,
  ScopeInsufficientError,
  // Tenant
  TenantNotFoundError,
  TenantSuspendedError,
  TenantAccessDeniedError,
  // Source
  SourceNotFoundError,
  SourceRateLimitError,
  SourceCredentialInvalidError,
  // Policy
  PolicyNotActiveError,
  PolicyDeniedError,
  PolicyEscalateError,
  // Agent
  AgentNotFoundError,
  AgentInactiveError,
  ScopeHashMismatchError,
  ScopeExpiredError,
  // Action
  ActionNotFoundError,
  ActionAlreadyExecutedError,
  InsufficientBalanceError,
  LimitsExceededError,
  IdempotencyKeyReusedError,
  // Gate
  GateNoPolicyDecisionError,
  GatePolicyVersionStaleError,
  GateCounterpartyUnverifiedError,
  GateCounterpartySanctionedError,
  GateBalanceInsufficientError,
  GateApprovalIncompleteError,
  GateSessionKeyInvalidError,
  GateAuditChainStaleError,
  // Validation
  ValidationFailedError,
  MissingRequiredFieldError,
  InvalidCursorError,
  // Infrastructure
  RateLimitedError,
  InternalError,
  UpstreamTimeoutError,
  MaintenanceModeError,
} from "./errors/index.js";

export {
  BrainHttp,
  generateIdempotencyKey,
  looksLikeIdempotencyKey,
  type BrainHttpOptions,
  type HttpMethod,
  type RequestOptions,
} from "./http/index.js";

/**
 * OpenAPI-derived types. Regenerate via `pnpm --filter @brain/sdk run
 * generate-types` after every change to Brain_API_Specification.yaml.
 *
 * Re-exported under the `Schemas` namespace so callers can write
 * `Schemas.components["schemas"]["Account"]` without importing the
 * generated file directly.
 */
export type {
  components as Components,
  operations as Operations,
  paths as Paths,
} from "./generated/index.js";

// (namespace modules land in commits #9 and #11)
// (convenience surface lands in commit #11)
