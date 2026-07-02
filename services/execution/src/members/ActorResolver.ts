import { brainError } from "@brain/shared";
import type {
  ActorContext,
  MemberAuthority,
  MemberLookup,
  ResolveActorInput,
  SignedApprovalTokenClaims,
} from "./types.js";

export interface ActorResolverDeps {
  members: MemberLookup;
  verifyEmailToken?: (token: string) => Promise<SignedApprovalTokenClaims | null>;
}

export class ActorResolver {
  public constructor(private readonly deps: ActorResolverDeps) {}

  public async resolve(input: ResolveActorInput): Promise<ActorContext> {
    switch (input.kind) {
      case "session": {
        // The payload actor, if present, is intentionally ignored. Session
        // identity is derived only from authenticated server-side context.
        const member = await this.deps.members.findMemberById(input.ctx.tenantId, input.ctx.actor);
        return toActorOrThrow(member, "session");
      }
      case "api": {
        if (input.assertedActorId === undefined || input.assertedActorId === "") {
          throw actorUnresolved({ source: "api", asserted_by: input.ctx.actor });
        }
        const member = await this.deps.members.findMemberById(
          input.ctx.tenantId,
          input.assertedActorId,
        );
        return toActorOrThrow(member, "tenant_asserted", input.ctx.actor);
      }
      case "surface": {
        const member = await this.deps.members.findMemberByIdentityLink({
          tenantId: input.tenantId,
          surface: input.surface,
          externalRef: input.externalRef,
        });
        return toActorOrThrow(member, "surface_linked");
      }
      case "email": {
        if (this.deps.verifyEmailToken === undefined) {
          throw actorUnresolved({ source: "email", proposal_id: input.proposalId });
        }
        const claims = await this.deps.verifyEmailToken(input.token);
        if (
          claims === null ||
          claims.tenantId !== input.tenantId ||
          claims.proposalId !== input.proposalId
        ) {
          throw actorUnresolved({ source: "email", proposal_id: input.proposalId });
        }
        const member =
          claims.memberId !== undefined
            ? await this.deps.members.findMemberById(input.tenantId, claims.memberId)
            : await this.deps.members.findMemberByEmail(
                input.tenantId,
                claims.email ?? claims.recipient ?? "",
              );
        return toActorOrThrow(member, "signed_token");
      }
    }
  }
}

function toActorOrThrow(
  member: MemberAuthority | null,
  verification: ActorContext["verification"],
  assertedBy?: string,
): ActorContext {
  if (member === null) throw actorUnresolved({ verification });
  return {
    memberId: member.id,
    email: member.email,
    verification,
    ...(assertedBy !== undefined ? { assertedBy } : {}),
  };
}

export function actorUnresolved(details: Record<string, unknown> = {}): Error {
  return brainError("payment_intent_approval_invalid", "actor_unresolved", {
    statusOverride: 403,
    details: { reason: "actor_unresolved", ...details },
  });
}
