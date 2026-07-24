import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { operations } from "../generated/openapi.js";

export type CreateSessionBody = NonNullable<
  operations["createSession"]["requestBody"]
>["content"]["application/json"];
export type CreateSessionResult =
  operations["createSession"]["responses"]["200"]["content"]["application/json"];

export type RefreshSessionBody = NonNullable<
  operations["refreshSession"]["requestBody"]
>["content"]["application/json"];
export type RefreshSessionResult =
  operations["refreshSession"]["responses"]["200"]["content"]["application/json"];

export type RevokeSessionResult =
  operations["deleteSession"]["responses"]["200"]["content"]["application/json"];

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class SessionsResource {
  constructor(private readonly http: BrainHttpClient) {}

  /**
   * `security: []`, gated by `X-Platform-Service-Auth`. Exchanges a
   * platform identity (`external_ref`) for a member session.
   */
  async create(platformServiceAuth: string, body: CreateSessionBody): Promise<CreateSessionResult> {
    const { data, error, response } = await this.http.POST("/sessions", {
      body,
      headers: { "X-Platform-Service-Auth": platformServiceAuth },
    });
    // The 403 response is a spec-level `oneOf` (standard Error envelope, OR a
    // bare `{ reason: "session_identity_unlinked" }`), BrainAPIError
    // degrades the latter shape to code "unknown" via `body?.error`.
    return unwrap(data, error as BrainErrorBody | undefined, response.status);
  }

  /**
   * `security: []`, no header or bearer token, just the refresh token
   * itself. Refresh tokens are single-use; reuse revokes the whole family.
   */
  async refresh(body: RefreshSessionBody): Promise<RefreshSessionResult> {
    const { data, error, response } = await this.http.POST("/sessions/refresh", { body });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires a `user`-type bearer JWT. Revokes every refresh token for the
   * calling member; the current access token stays valid until it expires.
   */
  async revoke(): Promise<RevokeSessionResult> {
    const { data, error, response } = await this.http.DELETE("/sessions");
    return unwrap(data, error, response.status);
  }
}
