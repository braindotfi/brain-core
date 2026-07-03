# AGENTS.md

Operational notes for coding agents working in brain-core. Keep this aligned
with `CLAUDE.md` and the contract docs.

## Required Checks

- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm run check-invariants`
- `pnpm run check-no-em-dashes`

## Members Approval Model

The normative contract is `docs/contracts/members-attribution.md`. Core leads
the model; platform clients conform to the contract and remain mock-only until
wired to core APIs.

Approval actors are never accepted from payload fields on session surfaces.
Session actors come from authenticated server context. API machine credentials
must assert an actor and are recorded as `tenant_asserted`. Slack and Teams
resolve through `member_identity_links`. Email approvals use signed tokens bound
to the tenant and proposal.

Tenant provisioning must create one active bootstrap admin member in the same
transaction as the tenant row. Self-serve signup uses the owner user id as the
member id. Demo provision-run uses the minted bootstrap user id as the member id
and returns a separate user-principal member session for member and approval
workflows. Missing email is written as `bootstrap+<tenantId>@brain.invalid` and
can be patched by an admin later.

Agent principals are propose-only at the identity layer. They must never resolve
as members, receive member claims, or carry approval/member admin scopes.

`PaymentIntentService.approve` must resolve the actor and call
`authorizeApproval` before any approval signature or status transition. The gate
checks are ordered:

1. Actor resolves to an active member of the tenant.
2. Member role permits approval: admin or approver.
3. Proposal domain is in the member approval domains.
4. Amount is within the member per-item limit.
5. Actor is not the payee.
6. Tenant-wide second approval requires a distinct member when triggered.

Second approval moves the intent to `awaiting_second_approval` and blocks
execution until another eligible member completes approval. Same-member retry
returns `second_approval_required`.

Members are deactivated, never hard-deleted. The last active admin cannot be
deactivated or demoted and returns `last_admin_protected`.

Actor-payee protection normalizes email by trimming, lowercasing, and stripping
plus-address aliases. Employee or payroll payees with unresolved email fail
closed as `self_approval_blocked` with `payee_unresolved=true`. Vendor payees
with unresolved email still pass in v1 as an accepted residual gap until
canonical vendor identity links are first-class in Ledger.

Member mutations emit `member.changed` audit events with before and after
envelopes and return `audit_id`. Awaiting second approval emits
`proposal.awaiting_second_approval`; the outbound webhook allowlist also accepts
the old payment-intent alias for compatibility.

## Copy Rules

No em dashes, no ampersands outside brand names, no emojis in docs, comments, or
commit messages.
