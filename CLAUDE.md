# CLAUDE.md (brain-core root)

Monorepo working notes. Keep current as work lands.

## Layout

Private workspace, UNLICENSED.

- `packages/surfaces` (@brain/surfaces): propose-only delivery and approval for
  the four public agents across Slack, Microsoft Teams, and email. Depends on
  nothing in core. Defines the surface ports as interfaces.
- `packages/core` (@brain/core): implements those ports against brain-core's
  internal services and hosts the composition root. Depends on @brain/surfaces.
- `services/surface-gateway` (@brain/surface-gateway): Fastify v5 deployable for
  Slack, Teams, and email approval webhooks. Depends on @brain/core,
  @brain/surfaces, and existing policy, audit, and execution services.

Dependency is one-directional and acyclic: core -> surfaces. A CI check should
fail the build if anything under packages/surfaces imports @brain/core.

## Branch

`feature/members-approval-attribution`. Branch from latest `origin/main`.
Members, approval authority, and actor attribution are moving into core as the
normative money-path contract in `docs/contracts/members-attribution.md`.

## Commands (from root)

- `pnpm --filter @brain/surfaces run typecheck`
- `pnpm --filter @brain/core run typecheck`
- `pnpm --filter @brain/surface-gateway run typecheck`
- `pnpm --filter @brain/surfaces run test`
- `pnpm --filter @brain/core run test`
- `pnpm --filter @brain/surface-gateway run test`
- `pnpm run check-surface-acyclic`
- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`

Surfaces must be built before core typechecks when consuming the package export,
because core resolves @brain/surfaces through its built dist. The root scripts
include the packages in the workspace filters.

## Where the port implementations land

`packages/core/src/bindings/` holds the bindings, one per surface port:

- `identity.ts` -> RLS-scoped tenant identity
- `policy.ts` -> the policy engine and the 23 gates
- `audit.ts` -> the immutable Audit log
- `approvals.ts` -> post-audit approval signature recording
- `execution.ts` -> the idempotent execution queue

`buildBrainCorePorts(services)` assembles them. `buildSurfaceRuntime` in
`packages/core/src/composition/` wires ports, adapters, dispatcher, and approval
service into the object the inbound webhook deployable boots.

## Status

Done

- Monorepo workspace with one-directional core -> surfaces dependency, verified.
- Surfaces package (schema, hashing, ports, dispatcher, approval pipeline, three
  adapters, four agent factories). Strict typecheck clean, focused tests green.
- Core bindings for the surface ports, plus the composition root.
- End-to-end runtime test: dispatch to Slack then approve, with audit before
  execution. Green.
- Inbound helper layer: Slack signature verification before parsing, email
  confirmation plus POST approval route, and Teams submit handler.
- Live transport client seams: Slack Web API client, Teams Bot Framework
  proactive client, Bot Framework activity verifier, conversation-reference
  store, and generic HTTP ESP client.
- Delivered-ref persistence from Dispatcher and terminal decision idempotency at
  the approval store boundary, including crash-safe unapplied replay.
- Slack outcomes are posted through `response_url`; background approval errors
  are caught and logged.
- Fastify v5 surface gateway deployable in `services/surface-gateway` with:
  `/surfaces/slack/interactions`, `/surfaces/slack/oauth/*`,
  `/surfaces/email/approve`, `/surfaces/email/verify`,
  `/surfaces/email/recipients/verify/start`, `/surfaces/email/routes`,
  `/surfaces/email/domains`, `/surfaces/email/events`,
  `/surfaces/teams/messages`, `/surfaces/teams/install`, `/surfaces/teams/revoke`,
  `/surfaces/smoke/proposals`, and `/healthz`.
- Gateway-owned RLS tables for external identity links, canonical surface
  proposals, delivered refs, terminal decisions, Slack retry keys, and Teams
  conversation references.
- Slack and Teams installation stores are tenant scoped. Slack verifies
  workspace to Brain tenant at click time. Teams resolves authenticated Azure AD
  tenant to Brain tenant before storing conversation references or accepting
  Adaptive Card actions.
- Email onboarding verifies recipients before links are routed or clicks are
  honored. Agent email routes expand only to verified active recipients. Tenant
  custom-from domains require SPF, DKIM, and DMARC verification, and ESP bounce
  or complaint events disable recipients.
- Gateway composition delegates to existing policy evaluation, shared audit
  emitter idempotency keys, and execution approvals. It never writes ledger
  money-path rows and never touches `execution_outbox`.
- `brain_surface_gateway` DB role is NOBYPASSRLS and is granted only surface
  state, users and active policy reads, plus approval writes.
- Production and dev compose wire the gateway as a separate process so Slack,
  Teams, and ESP credentials are not loaded into the core API process.
- Tests cover Slack signature valid, stale, tampered, ack timing, outcome
  posting, and logged failures; email GET and HEAD confirmation, POST approval,
  missing and invalid tokens; dual approval, double-click idempotency, crash-safe
  replay, expired proposal clicks, Slack retry dedupe, email approval POST, and
  the smoke proposal trigger.
- Approval signatures are recorded through a post-audit port, so policy
  evaluation is read-only and execution enqueue does not sign. Tests cover
  audit-before-sign ordering, awaiting dual approval signatures, terminal
  no-double-sign behavior, roleless signer denial, and disabled user rejection.
- Slack OAuth install, Teams install and revoke, and email onboarding endpoints
  now require `surfaces:admin` bearer auth. The gateway derives Brain tenant
  identity from the principal and ignores tenant ids in request bodies.
- Email domain onboarding verifies SPF, DKIM, and DMARC from DNS before
  activating tenant custom-from domains. Slack OAuth state uses
  `SLACK_INSTALL_STATE_SECRET` instead of the OAuth client secret.
- Members are now the core approval authority model. `members` and
  `member_identity_links` are tenant-scoped RLS tables; authenticated identities
  are backfilled as tenant admins on upgrade to preserve behavior.
- Tenant provisioning must create one active bootstrap admin member in the same
  transaction as the tenant row. The bootstrap member uses all approval domains,
  a per-item limit of `9223372036854775807`, no second-approver threshold, and
  `active=true`. Self-serve signup uses the owner user id as the member id.
  Demo provision-run uses the minted bootstrap user id as the member id and
  returns a separate user-principal member session for member and approval
  workflows. Missing email is written as `bootstrap+<tenantId>@brain.invalid`
  and can be patched by an admin later.
- Approval actors resolve through `ActorResolver` only. Session surfaces derive
  the actor from authenticated server context and ignore any actor field in the
  payload. Session actor resolution requires `principal_type=user`; agent
  principals are propose-only and never member-resolvable. API machine
  credentials must assert an actor and are recorded as `tenant_asserted`; Slack
  and Teams resolve through identity links; email uses signed proposal-bound
  tokens.
- `PaymentIntentService.approve` resolves the actor and calls
  `authorizeApproval` before any approval signature or status transition. The
  gate checks, in order: active tenant member, admin or approver role, authorized
  domain, per-item limit, actor is not the payee, and tenant-wide distinct
  second approval.
- Second approval moves payment intents to `awaiting_second_approval` and gates
  execution until a distinct member passes the authority checks. Same-member
  retry returns `second_approval_required`.
- Members are deactivated, never hard-deleted. The last active admin in a tenant
  cannot be deactivated or demoted and returns `last_admin_protected`.
- Actor-payee protection normalizes emails by trimming, lowercasing, and
  stripping plus-address aliases. Employee or payroll payees with unresolved
  email fail closed as `self_approval_blocked` with `payee_unresolved=true`.
  Vendor payees with unresolved email still pass in v1 as an accepted residual
  gap until canonical vendor identity links are first-class in Ledger.
- Member mutations emit `member.changed` audit events with before and after
  envelopes and return `audit_id`. Awaiting-second-approval emits the contract
  event `proposal.awaiting_second_approval`; the older payment-intent alias
  remains accepted by the outbound webhook allowlist for compatibility.
- The platform repo must conform to `docs/contracts/members-attribution.md`.
  Platform-side member UI is mock-only until it is wired against the core
  `/v1/members` API and core approval responses.

### Deployment

Production promotion now runs `tools/migrate up` against `DATABASE_URL_PROD`
inside the `promote_production` GitHub environment before updating the
production Container App revision. The migration runner is idempotent: applied
migrations with matching hashes are skipped, drift fails the job, and a failed
migration exits nonzero before any new revision is shipped. This replaces the
previous manual and unowned production migration step, which caused the members
promote to deploy app code before migrations 0023 and 0024 existed in prod.

After the production app update, `promote_production` curls the production
health URL and fails the job if no 2xx response is observed. The default smoke
target is `https://api.brain.fi/health`; override with
`BRAIN_PRODUCTION_HEALTH_URL` when needed.

#### Current deployment state

Update this table on every promote.

| Change                                                                  | On main | On staging | On prod (api.brain.fi)                                                                                |
| ----------------------------------------------------------------------- | ------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| Members / approval authority / actor attribution (PR #214, #215)        | Yes     | Yes        | NO, prior probe failed: provision-run 500 internal_server_error before prod migrations were automated |
| Approval-authority gap fixes (PR #216)                                  | Yes     | Yes        | NO, prior probe failed: provision-run 500 internal_server_error before prod migrations were automated |
| Tenant bootstrap member (PR #218)                                       | Yes     | Yes        | NO, prior probe failed: provision-run 500 internal_server_error before prod migrations were automated |
| Bootstrap member session split: member_token in provision-run (PR #219) | Yes     | Yes        | NO, prior probe failed: provision-run 500 internal_server_error before prod migrations were automated |

Provision-run returns `tokens.member.token` for user-principal member and
approval workflows and `tokens.agent.token` for propose-only agent workflows.
The agent token returning `403 actor_unresolved` on `/v1/members` is by design
and is a permanent invariant.

Pending

- [ ] Real agent input types from the detectors.
- [ ] Slack Marketplace MCP registry listing for the pull path.
- [ ] Provision real Slack, Teams, and ESP credentials in staging and run an
      exercised surface approval release candidate.
- [ ] Replace the vendor unresolved-email residual gap with canonical vendor
      identity matching once those links are first-class in the Ledger model.

## Runtime isolation

Run the surface webhook deployable as its own least-privilege process. The Slack,
Teams, and ESP credentials must not live in the core protocol service. Same repo,
separate deploy.

## Copy

No em dashes, no ampersands outside brand names, no emojis in docs, comments, or
commit messages.
