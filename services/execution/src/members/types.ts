import type { ServiceCallContext } from "@brain/shared";

export type MemberRole = "admin" | "approver" | "viewer";
export type MemberStatus = "invited" | "active" | "deactivated";
export type ApprovalDomain = "ap" | "ar" | "treasury" | "payroll" | "reconciliation";
export type ActorVerification =
  | "session"
  | "idp_verified"
  | "surface_linked"
  | "signed_token"
  | "tenant_asserted";
export type MemberIdentitySurface = "slack" | "teams" | "email" | "platform";

export interface MemberAuthority {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: MemberRole;
  status: MemberStatus;
  active: boolean;
  approvalDomains: ApprovalDomain[];
  perItemLimitCents: bigint;
  requiresSecondApproverAboveCents: bigint | null;
}

export interface ActorContext {
  memberId: string;
  email: string;
  role: MemberRole;
  active: boolean;
  verification: ActorVerification;
  assertedBy?: string;
}

export interface MemberLookup {
  findMemberById(tenantId: string, memberId: string): Promise<MemberAuthority | null>;
  findMemberByEmail(tenantId: string, email: string): Promise<MemberAuthority | null>;
  findMemberByIdentityLink(input: {
    tenantId: string;
    surface: MemberIdentitySurface;
    externalRef: string;
  }): Promise<MemberAuthority | null>;
}

export interface SignedApprovalTokenClaims {
  tenantId: string;
  proposalId: string;
  memberId?: string;
  email?: string;
  recipient?: string;
}

export type ResolveActorInput =
  | {
      kind: "session";
      ctx: ServiceCallContext;
      /** Ignored by design. Session actors are derived only from ctx.actor. */
      payloadActorId?: unknown;
    }
  | {
      kind: "api";
      ctx: ServiceCallContext;
      assertedActorId?: string;
    }
  | {
      kind: "surface";
      tenantId: string;
      surface: Exclude<MemberIdentitySurface, "email">;
      externalRef: string;
    }
  | {
      kind: "email";
      tenantId: string;
      proposalId: string;
      token: string;
    };
