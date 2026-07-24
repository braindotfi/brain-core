import type { BrainHttpClient } from "../client.js";
import { BrainAPIError, type BrainErrorBody } from "../errors.js";
import type { components, operations } from "../generated/openapi.js";

export type Member = components["schemas"]["Member"];
export type MemberCreateRequest = components["schemas"]["MemberCreateRequest"];
export type MemberUpdateRequest = components["schemas"]["MemberUpdateRequest"];
export type MemberIdentityLinkRequest = components["schemas"]["MemberIdentityLinkRequest"];

export type ListMembersParams = NonNullable<operations["listMembers"]["parameters"]["query"]>;
export type ListMembersResult =
  operations["listMembers"]["responses"]["200"]["content"]["application/json"];

export type CreateMemberResult =
  operations["createMember"]["responses"]["201"]["content"]["application/json"];

export type UpdateMemberResult =
  operations["updateMember"]["responses"]["200"]["content"]["application/json"];

export type DeactivateMemberResult =
  operations["deactivateMember"]["responses"]["200"]["content"]["application/json"];

export type CreateMemberInviteResult =
  operations["createMemberInvite"]["responses"]["200"]["content"]["application/json"];

export type RevokeMemberInviteResult =
  operations["revokeMemberInvite"]["responses"]["200"]["content"]["application/json"];

export type MemberIdentityLinkResult =
  operations["createMemberIdentityLink"]["responses"]["200"]["content"]["application/json"];

function unwrap<T>(data: T | undefined, error: BrainErrorBody | undefined, status: number): T {
  if (error !== undefined || data === undefined) {
    throw new BrainAPIError(status, error);
  }
  return data;
}

export class MembersResource {
  constructor(private readonly http: BrainHttpClient) {}

  /** Requires `execution:read` and a resolvable active member as the caller. */
  async list(params: ListMembersParams = {}): Promise<ListMembersResult> {
    const { data, error, response } = await this.http.GET("/members", {
      params: { query: params },
    });
    return unwrap(data, error, response.status);
  }

  /** Requires `execution:read` and a resolvable active member as the caller. */
  async get(id: string): Promise<Member> {
    const { data, error, response } = await this.http.GET("/members/{id}", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires `execution:admin` and an active admin caller. With
   * `invite: true`, the member is created `status: invited` and the
   * response carries a one-time `invite_token` to exchange via
   * `brain.invites.consume`.
   */
  async create(body: MemberCreateRequest): Promise<CreateMemberResult> {
    const { data, error, response } = await this.http.POST("/members", { body });
    return unwrap(data, error, response.status);
  }

  /** Requires `execution:admin` and an active admin caller. Only fields present in the body change. */
  async update(id: string, body: MemberUpdateRequest): Promise<UpdateMemberResult> {
    const { data, error, response } = await this.http.PATCH("/members/{id}", {
      params: { path: { id } },
      body,
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires `execution:admin` and an active admin caller. Deactivates
   * (never hard-deletes) the member. The last active admin cannot be
   * deactivated.
   */
  async deactivate(id: string): Promise<DeactivateMemberResult> {
    const { data, error, response } = await this.http.DELETE("/members/{id}", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires `execution:admin` and an active admin caller. Revokes any
   * outstanding unconsumed invite for this member first, then issues a new
   * one (only one live invite token per member at a time).
   */
  async createInvite(id: string): Promise<CreateMemberInviteResult> {
    const { data, error, response } = await this.http.POST("/members/{id}/invites", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  /** Requires `execution:admin` and an active admin caller. */
  async revokeInvite(id: string): Promise<RevokeMemberInviteResult> {
    const { data, error, response } = await this.http.DELETE("/members/{id}/invites", {
      params: { path: { id } },
    });
    return unwrap(data, error, response.status);
  }

  /**
   * Requires `execution:admin` and an active admin caller. Links an
   * external Slack, Teams, or email identity so surface approvals resolve
   * to this member's approval authority.
   */
  async addIdentityLink(
    id: string,
    body: MemberIdentityLinkRequest,
  ): Promise<MemberIdentityLinkResult> {
    const { data, error, response } = await this.http.POST("/members/{id}/identity-links", {
      params: { path: { id } },
      body,
    });
    return unwrap(data, error, response.status);
  }

  /** Requires `execution:admin` and an active admin caller. */
  async removeIdentityLink(
    id: string,
    body: MemberIdentityLinkRequest,
  ): Promise<MemberIdentityLinkResult> {
    const { data, error, response } = await this.http.DELETE("/members/{id}/identity-links", {
      params: { path: { id } },
      body,
    });
    return unwrap(data, error, response.status);
  }
}
