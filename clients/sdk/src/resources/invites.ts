import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { operations } from "../generated/openapi.js";

export type ConsumeInviteBody = NonNullable<
  operations["consumeInvite"]["requestBody"]
>["content"]["application/json"];
export type ConsumeInviteResult =
  operations["consumeInvite"]["responses"]["200"]["content"]["application/json"];

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class InvitesResource {
  constructor(private readonly http: BrainHttpClient) {}

  /**
   * `security: []`, gated by `X-Platform-Service-Auth`. Links the
   * platform `external_ref` to the invited member, activates the member,
   * marks the invite consumed, and issues an initial member session.
   */
  async consume(
    platformServiceAuth: string,
    body: ConsumeInviteBody,
  ): Promise<ConsumeInviteResult> {
    const { data, error, response } = await this.http.POST("/invites/consume", {
      body,
      headers: { "X-Platform-Service-Auth": platformServiceAuth },
    });
    // The 403 response is a spec-level `oneOf` (standard Error envelope for
    // invite_expired/consumed/revoked, OR a bare `{ reason: "invite_invalid" }`
    // for an unknown token), BrainAPIError degrades the latter shape to
    // code "unknown" via `body?.error`.
    return unwrap(data, error as BrainErrorBody | undefined, response.status);
  }
}
