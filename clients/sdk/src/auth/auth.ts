/**
 * `brain.auth.*` — sign-in flows for external agents.
 *
 * Wraps the /v1/auth/siwx routes added in PLAN-FIRST #15. Source:
 * https://docs.brain.fi/api-reference/authentication and
 * https://docs.brain.fi/sdks/overview ("`brain.auth.signInWithSIWX()`").
 *
 * Human users authenticate via the existing SIWE flow (POST
 * /v1/auth/verify) — that's a separate SDK surface; this module is
 * the agent-side path.
 *
 * After a successful `signInWithSIWX`, the SDK rotates its internal
 * bearer token from the configured api key to the issued
 * `access_token`. Subsequent calls on the same Brain instance
 * authenticate as the agent.
 *
 * @packageDocumentation
 */

import type { BrainHttp } from "../http/index.js";

/** Result of `/auth/siwx/challenge`. */
export interface SiwxChallenge {
  readonly nonce: string;
  readonly session_id: string;
  readonly domain: string;
}

export interface RequestChallengeOptions {
  /**
   * Optional hint — the server may use it to pre-fetch the agent's
   * registration record so the verify call is faster.
   */
  readonly agentAddress?: string;
}

export interface SignInWithSIWXOptions {
  readonly message: string;
  readonly signature: string;
  /**
   * The session id returned by `requestChallenge`. Required unless
   * the caller pre-shared a nonce out-of-band.
   */
  readonly sessionId?: string;
  /**
   * When true (default), the SDK rotates its internal bearer token to
   * the issued access_token so subsequent calls authenticate as the
   * agent. Set to false to inspect the result without changing state.
   */
  readonly rotateBearer?: boolean;
}

export interface SignInWithSIWXResult {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly principal: {
    readonly id: string;
    readonly type: "agent";
    readonly tenantId: string;
    readonly scopes: readonly string[];
  };
}

export class AuthModule {
  public constructor(private readonly http: BrainHttp) {}

  /**
   * Request a SIWX challenge nonce.
   *
   * Implements `POST /auth/siwx/challenge` (operationId `siwxChallenge`).
   * Returns the nonce the agent should embed in its signed message and
   * the session_id to echo back on `signInWithSIWX`.
   *
   * @see https://docs.brain.fi/api-reference/authentication
   */
  public async requestChallenge(opts: RequestChallengeOptions = {}): Promise<SiwxChallenge> {
    return this.http.post<SiwxChallenge>(
      "/auth/siwx/challenge",
      opts.agentAddress !== undefined ? { agent_address: opts.agentAddress } : {},
    );
  }

  /**
   * Verify a SIWX-signed message and exchange it for an agent_token.
   *
   * Implements `POST /auth/siwx` (operationId `siwxVerify`). On success
   * the SDK rotates its bearer to the issued `access_token` (unless
   * `rotateBearer: false` is set), so the same `Brain` instance can
   * be used for authenticated calls immediately afterward.
   *
   * @see https://docs.brain.fi/sdks/overview
   */
  public async signInWithSIWX(opts: SignInWithSIWXOptions): Promise<SignInWithSIWXResult> {
    const body: Record<string, unknown> = {
      message: opts.message,
      signature: opts.signature,
      ...(opts.sessionId !== undefined ? { session_id: opts.sessionId } : {}),
    };
    const result = await this.http.post<SignInWithSIWXResult>("/auth/siwx", body);
    if (opts.rotateBearer !== false) {
      this.http.setBearerToken(result.access_token);
    }
    return result;
  }

  /**
   * Clear the current bearer token. Use after server-side revocation
   * or when the host application logs out. Subsequent requests will
   * include an empty Authorization header and the server will return
   * `auth_token_missing` (401).
   */
  public signOut(): void {
    this.http.setBearerToken(null);
  }
}
