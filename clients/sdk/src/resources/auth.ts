import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { operations } from "../generated/openapi.js";

export type SignupBody = NonNullable<
  operations["signup"]["requestBody"]
>["content"]["application/json"];
export type SignupResult = operations["signup"]["responses"]["201"]["content"]["application/json"];

export type VerifyEmailBody = NonNullable<
  operations["verifyEmail"]["requestBody"]
>["content"]["application/json"];
export type VerifyEmailResult =
  operations["verifyEmail"]["responses"]["200"]["content"]["application/json"];

export type LoginBody = NonNullable<
  operations["ownerLogin"]["requestBody"]
>["content"]["application/json"];
export type LoginResult =
  operations["ownerLogin"]["responses"]["200"]["content"]["application/json"];

export type SiwxChallengeResult =
  operations["siwxChallenge"]["responses"]["200"]["content"]["application/json"];

export type SiwxVerifyBody = NonNullable<
  operations["siwxVerify"]["requestBody"]
>["content"]["application/json"];
export type SiwxVerifyResult =
  operations["siwxVerify"]["responses"]["200"]["content"]["application/json"];

/**
 * The `security: []` (public, no bearer token) auth routes: signup, email
 * verification, password login, and SIWX. These are how a caller GETS a
 * credential, so unlike every other resource this one talks to the API
 * directly over `fetch`/`baseUrl` rather than through the token-authenticated
 * `BrainHttpClient` (which requires a token/apiKey to construct at all).
 * Also exposed as `brain.auth` on a regular `new Brain(...)` instance, but
 * that constructor itself requires a token/apiKey; use `Brain.public(...)`
 * to reach this before you hold one.
 */
export class AuthResource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await res.json().catch(() => undefined)) as
      | (T & { error?: undefined })
      | BrainErrorBody
      | undefined;
    if (!res.ok || json === undefined || json === null || "error" in json) {
      throw new BrainAPIError(res.status, json as BrainErrorBody | undefined);
    }
    return json;
  }

  /**
   * Self-serve sandbox tenant signup. Requires `BRAIN_SELF_SERVE_SIGNUP`
   * server-side, or 401s (the global auth hook rejects the route as
   * unregistered when the flag is off; it does not 404). That flag defaults
   * to false and is off on every real deployment today.
   */
  async signup(body: SignupBody): Promise<SignupResult> {
    return this.post<SignupResult>("/signup", body);
  }

  /**
   * Consumes the single-use token from `signup` to activate the owner.
   * Registered behind the same `BRAIN_SELF_SERVE_SIGNUP` flag as `signup`,
   * so it's unreachable (401) wherever `signup` is.
   */
  async verifyEmail(body: VerifyEmailBody): Promise<VerifyEmailResult> {
    return this.post<VerifyEmailResult>("/auth/verify-email", body);
  }

  /**
   * Email + password → a short-lived owner JWT (management/read/approve
   * scopes only). Registered behind the same `BRAIN_SELF_SERVE_SIGNUP` flag
   * as `signup`, so it's unreachable (401) wherever `signup` is.
   */
  async login(body: LoginBody): Promise<LoginResult> {
    return this.post<LoginResult>("/auth/login", body);
  }

  /** Requests a one-time EIP-4361 nonce, held server-side for 5 minutes. */
  async siwxChallenge(): Promise<SiwxChallengeResult> {
    return this.post<SiwxChallengeResult>("/auth/siwx/challenge", {});
  }

  /** Exchanges a signed EIP-4361 message for an owner or agent token. */
  async siwx(body: SiwxVerifyBody): Promise<SiwxVerifyResult> {
    return this.post<SiwxVerifyResult>("/auth/siwx", body);
  }
}
