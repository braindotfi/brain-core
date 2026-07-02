# Members, Approval Authority, and Actor Attribution Contract

## Types

```ts
type MemberRole = "admin" | "approver" | "viewer";
type ApprovalDomain = "ap" | "ar" | "treasury" | "payroll" | "reconciliation";
interface Member {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: MemberRole;
  active: boolean;
  approval: {
    domains: ApprovalDomain[];
    perItemLimit: number; // cents
    requiresSecondApproverAbove?: number; // cents, nullable, unused v1
  };
  createdLabel: string;
  identityLinks: {
    surface: "slack" | "teams" | "email";
    externalRef: string;
    linkedAtLabel: string;
  }[];
}
type ActorVerification =
  | "session"
  | "idp_verified"
  | "surface_linked"
  | "signed_token"
  | "tenant_asserted";
interface ActorContext {
  memberId: string;
  email: string;
  verification: ActorVerification;
  assertedBy?: string;
}
```

## Enforcement Checks

Exact order; evaluated before any approve state transition:

1. Actor resolves to an ACTIVE member of the tenant.
2. Member role permits approving (admin or approver; viewer never).
3. Proposal domain in member.approval.domains.
4. Amount <= member.approval.perItemLimit.
5. Tenant-wide second-approval rule: amount above the tenant threshold -> this approval is recorded as the FIRST of two; proposal status -> "awaiting_second_approval"; execution gated until a DISTINCT member passing checks 1-4 completes it. Same member twice -> rejected.
6. ACTOR != PAYEE: a member may never approve a payment whose resolved recipient is themselves. Non-configurable. Same tier as the fraud guards.

## Structured Rejection Reasons

403 body `{ error, reason, detail }`:

```txt
actor_unresolved | actor_inactive | domain_not_authorized | actor_limit_exceeded |
second_approval_required | self_approval_blocked | last_admin_protected
```

## Status

Add `"awaiting_second_approval"` to the proposal status enum.

## API Shape

```txt
GET  /v1/members            (list; filter role/domain)     - any member (read)
POST /v1/members                                            - admin only
GET  /v1/members/{id}
PATCH /v1/members/{id}      (role, approval envelope, active) - admin only
DELETE /v1/members/{id}     -> DEACTIVATE only, never hard-delete (audit continuity)
POST/DELETE /v1/members/{id}/identity-links                 - admin only
Approve response: { status, approvals: [{memberId, at, verification}], actor: {memberId,
verification} }
Webhooks: member.changed, proposal.awaiting_second_approval
Every member mutation returns an audit_id and emits a member_change audit event
(before/after envelope). Every REJECTED approval emits approval_rejected (reason + actor).
```

## Actor Derivation Rules

Normative:

- Session (Brain UI): actor derived server-side from OAuth session; any actor field in the payload is STRIPPED AND IGNORED. `verification="session"`.
- API machine credential: mutating calls REQUIRE an asserted actor; recorded `verification="tenant_asserted"`, `assertedBy=<credential id>`. No actor -> reject (`actor_unresolved`). Never default to a service identity.
- Adapters (Slack/Teams): resolve via `member_identity_links` by `externalRef`; `verification="surface_linked"`. Unlinked identity -> structured failure, never a guess.
- Email: validate signed token bound to member + proposal; `verification="signed_token"`. Above a configurable step-up amount, the email link must route to an authenticated session rather than accepting the bare click.
- `"idp_verified"` is a stub enum value in v1 (no flow); schema-stable for the bank pilot.
