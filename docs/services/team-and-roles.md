# Team And Roles

## Investigation Findings

User records live in the existing `users` table from
`services/execution/migrations/0005_users.sql`. That table carries `id`,
`tenant_id`, `email`, `role`, and auth fields added later, including
`password_hash`, `email_verified_at`, and `status`.

Tenant approval actors live in `members`, introduced by
`services/execution/migrations/0023_members.sql`. `members` is the authority
model used by approvals and surface attribution. It carries `id`, `tenant_id`,
`email`, `display_name`, `role`, `status`, `active`, approval domains, per-item
approval limit, and second-approval threshold.

Audit actor ids already point at users or members. `ActorResolver` resolves a
session actor from authenticated server context by loading the `members` row
with the same id. The Postgres audit emitter now enriches missing
`actor_display_name` and `actor_email` from `members`.

The auth middleware provides `request.principal` with `id`, `tenantId`, `type`,
and scopes. Member routes reject non-user principals for member authority. API
machine callers can assert an actor only through explicitly supported flows.

RBAC exists today through JWT scopes and `members.role`. Existing roles were
`admin`, `approver`, and `viewer`; this PR extends them to `owner`, `admin`,
`approver`, `analyst`, and `viewer`. Session scopes are still derived from the
member role.

## Model

`members.role` and `users.role` now accept:

- `owner`: full tenant authority.
- `admin`: full authority except ownership transfer and billing ownership.
- `approver`: can decide proposals subject to per-agent authority.
- `analyst`: read access across agents, no decisions.
- `viewer`: read access without audit log.

`user_agent_authority` stores per-user, per-agent overrides:

- `can_approve`
- `can_edit`
- `can_reject`
- `max_amount_cents`
- `can_delegate`

Missing authority rows preserve backward compatibility and do not restrict the
user beyond their global role.

## Team API

`GET /v1/team?tenant_id=...` lists active and inactive tenant users with role,
per-agent authority summary, and last active timestamp.

`POST /v1/team/invite` creates an invited member, writes optional
`user_agent_authority` rows, creates a `pending_invites` token row, and returns
the invite URL.

`POST /v1/team/accept` accepts the token, activates the member, creates or
updates the `users` auth row, and emits `user.joined`.

`PATCH /v1/team/{user_id}` updates role, active status, and authority rows.

`DELETE /v1/team/{user_id}` soft deletes by deactivating the member. Audit
history remains intact.

## Decision Enforcement

For non-money proposals, `ProposalDecisionService` checks:

1. Global member role permission.
2. Matching `user_agent_authority` for the actor and proposal agent.
3. Rules engine authority with actor role and per-user authority in the rule
   payload.

If any layer denies, the service emits `decision.denied`, transitions the
proposal to `blocked`, and returns the blocked result without executing a
decision handler. Existing proposals without authority rows still follow the
old role-based behavior.

Money-path approvals still flow through `PaymentIntentService.approve`, which
keeps the existing member approval policy and does not change the
`PaymentIntent` schema.

## Directory Sync

`DirectoryProvider` is pluggable. The default `NoneDirectoryProvider` returns an
empty roster and performs no writes. `okta`, `google_workspace`, and
`microsoft_entra` are represented as TODO-compatible provider kinds for future
adapters. Roles remain manually assigned in Brain.

## Migration Note

Existing users and members are backfilled to `owner` for the earliest active
member per tenant and otherwise keep their existing role where possible. New
authority rows are optional, so existing clients and decision endpoints remain
compatible.
