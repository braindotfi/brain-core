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
type PayeeKind = "vendor" | "employee";
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
5. ACTOR != PAYEE: a member may never approve a payment whose resolved recipient is themselves. Non-configurable. Same tier as the fraud guards. Compare normalized emails by trimming, lowercasing, and stripping plus-address aliases from the local part.
6. Tenant-wide second-approval rule: amount above the tenant threshold -> this approval is recorded as the FIRST of two; proposal status -> "awaiting_second_approval"; execution gated until a DISTINCT member passing checks 1-4 completes it. Same member twice -> rejected.

Payee identity rule:

- Employee or payroll payees are conservative on unknown identity. If the payee email is unresolved, reject with `self_approval_blocked` and `detail.payee_unresolved=true`.
- Vendor payees without a resolved email pass in v1 only because canonical vendor identity links are not yet first-class in Ledger. This is an accepted residual gap until vendor identity links are added.
- A self-payee approval that would also require a second approver must reject with `self_approval_blocked`, never `second_approval_required`.

## Tenant Bootstrap

Every tenant is created with one initial active admin member in the same
transaction that creates the tenant row. The bootstrap member uses the same
authority defaults as the migration backfill: all approval domains,
`perItemLimit=9223372036854775807`, no second-approver threshold, and
`active=true`.

The bootstrap member id must match the user-principal session issued by that
provisioning path. Self-serve signup uses the owner user id. Demo provision-run
uses a minted bootstrap user id and returns two tokens: a user-principal member
session for member and approval workflows, and a separate propose-only agent
token for agent workflows. `resolveActor` still looks up only the authenticated
server-side actor as a member and never relaxes to a payload actor or a
tenant-level fallback.

Agent principals are never member-resolvable. Provisioning must not identity-link
the demo agent to the bootstrap member, add a member claim to an agent token, or
grant member or approval scopes to the agent token. The agent token exists to
propose; the user-principal member session exists to approve and administer
members.

Provisioning derives bootstrap email and display name from the provisioning
identity when available. If the identity has no email, provisioning writes a
documented placeholder email of `bootstrap+<tenantId>@brain.invalid`; an admin
can PATCH the member later once a real identity exists.

POST `/v1/members` remains admin-only because every tenant already has a
bootstrap admin. The post-0023 gap window is repaired by migration 0024, which
creates exactly one active admin for any tenant with zero members, preferring an
existing user id, then an existing agent id, then a deterministic placeholder.

## Structured Rejection Reasons

403 body `{ error, reason, detail }`:

```txt
actor_unresolved | actor_inactive | domain_not_authorized | actor_limit_exceeded |
self_approval_blocked | second_approval_required | last_admin_protected
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
