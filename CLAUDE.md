# CLAUDE.md (brain-core root)

Monorepo working notes. Keep current as work lands.

## Dev environment. WSL is the single source of truth

**All work happens in the WSL ext4 clone: `~/work/brain.fi/brain-core`.** Edit, build, run, git, and package-manager commands run there (native Linux, fast, LF endings). The Windows checkout at `C:\Users\sanke\Work\brain.fi\brain-core` is a **READ-ONLY mirror**. It exists only so Claude Desktop (a Windows GUI app that cannot open WSL paths) can read the source.

- **Never edit or commit on the Windows side.** Windows Edit/Write tools inject CRLF; the committed `.gitattributes` (`* text=auto eol=lf`) is the LF guard. If a Windows tool touches a file, normalize in WSL: `sed -i 's/\r$//' <file>`.
- **Refresh the mirror** after editing in WSL (and before reading it in Claude Desktop) with **`bfmirror`** (`~/work/brain.fi/sync-mirror.sh`, one-way WSL→Windows). Never run it the reverse direction.
- **The Windows side carries no `node_modules` or build output**. Those live only in WSL; `bfmirror` excludes them.

See the container-wide memory `brainfi-wsl-dev-setup` and `dev-environment`.

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
- Slack and Teams proposal prompts sanitize proposal-derived text before
  rendering. Slack mrkdwn escapes ampersand and angle bracket characters; Teams
  card text escapes markdown metacharacters in title, claim, evidence
  label/value, and action summary.
- Reusable inbound helpers fail closed on tenant binding. Slack interactions
  require an installation verifier at the type level. Teams submit helpers
  require a server-trusted Brain tenant and reject unsigned card tenant
  mismatches.
- Email onboarding verifies recipients before links are routed or clicks are
  honored. Agent email routes expand only to verified active recipients. Tenant
  custom-from domains require SPF, DKIM, and DMARC verification, and ESP bounce
  or complaint events disable recipients.
- Gateway composition delegates to existing policy evaluation, shared audit
  emitter idempotency keys, and execution approvals. It never writes ledger
  money-path rows and never touches `execution_outbox`.
- Surface smoke proposals fail closed: when enabled they require
  `BRAIN_SURFACE_SMOKE_SECRET`, and request checks use constant-time comparison.
- `brain_surface_gateway` DB role is NOBYPASSRLS and is granted only surface
  state, users and active policy reads, plus approval writes. Surface audit
  emission uses `brain_surface_audit_writer` through
  `BRAIN_SURFACE_GATEWAY_AUDIT_DB_URL`, with INSERT-only access to
  `audit_events`.
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
- Surface proposals may carry canonical server-side payee identity, included in
  the proposal hash. The surface decision gate blocks self-approval with
  `self_approval_blocked` by comparing the server-resolved approver email to the
  proposal payee email using the same normalization. Employee, payroll, and
  other payees with unresolved identity fail closed; vendor payees with
  unresolved email retain the v1 residual. Inbound Slack, Teams, and email
  payloads cannot supply or override proposal payee identity. Per-item limits
  and distinct second approver enforcement remain core/customer responsibility
  for surfaces in v1.
- Member mutations emit `member.changed` audit events with before and after
  envelopes and return `audit_id`. Awaiting-second-approval emits the contract
  event `proposal.awaiting_second_approval`; the older payment-intent alias
  remains accepted by the outbound webhook allowlist for compatibility.
- The platform repo must conform to `docs/contracts/members-attribution.md`.
  Platform-side member UI is mock-only until it is wired against the core
  `/v1/members` API and core approval responses.
- Manual counterparty creation, search, and identity edit are governed by
  `docs/contracts/counterparty-manual.md`. Ledger exposes
  `GET /ledger/counterparties`, `GET /ledger/counterparties/:id`,
  `POST /ledger/counterparties`, and `PATCH /ledger/counterparties/:id`.
  Manual create derives provenance from the principal: user principals write
  `human_confirmed`; agent and API partner principals write low-trust
  `agent_contributed`. Request bodies cannot set provenance, confidence,
  `verified_status`, or `risk_level`.
- Counterparty responses include `display_name`. If unset, it defaults to
  `name`. Manual create accepts `display_name` and aliases it when it differs
  from `name`; manual edit accepts `display_name`, aliases the previous display
  name, and does not change `normalized_name`.
- Counterparty list supports `verified_status` filtering for `unverified`,
  `self_attested`, `document_verified`, and `sanctions_cleared`.
- Manual counterparty create and edit are identity-only. Payment rail fields
  such as IBAN, account number, routing, SWIFT, BIC, wallet, and bank details
  are rejected with `payment_fields_not_allowed` and never write
  `ledger_counterparty_payment_instructions`.
- Unknown identity body fields return `unknown_field`; server-controlled trust
  fields return `field_not_editable`.
- Counterparty identity edits require a user principal, preserve the previous
  name as an alias on rename, keep aliases append-only, reject rename
  collisions with `name_conflict`, and emit `ledger.counterparty.updated`.
  New manual vendor creates emit `vendor.created` for vendor risk routing.
- Raw exposes `POST /v1/raw/:raw_id/extract` as an explicit trigger for the
  Python document extraction agent. The route requires `raw:write`, reads the
  artifact through tenant-scoped RLS, base64-encodes the blob, signs the
  outbound call with `BRAIN_AGENTS_INBOUND_SECRET` when
  `DOCUMENT_EXTRACT_AGENT_URL` is configured, and returns the parsed id and
  confidence. This is intentionally not an automatic post-ingest trigger.
  If `DOCUMENT_EXTRACT_AGENT_URL` is unset, the route returns 501 using
  `dependency_unavailable`.
- Owner password-login tokens now include `raw:read` and `raw:write` so a
  verified self-serve tenant owner can upload documents, trigger extraction, and
  read advisory ledger state. Owner tokens still exclude
  `payment_intent:propose`, `payment_intent:execute`, and `execution:propose`.
  Production self-serve signup sends verification tokens through the API ESP
  client using `EMAIL_ENDPOINT`, `EMAIL_API_KEY`, and optional `EMAIL_FROM`.
  When tokens are hidden and ESP credentials are missing, API boot fails before
  routes are registered.
- The document extraction agent keeps deterministic text extraction first for
  CSV, plain text, XLSX, and text-layer PDFs. Image uploads and scanned PDFs
  fall back to OCR through `OPENAI_OCR_MODEL` (default `gpt-4o`) with a 10 MB
  input guard, a 5 page PDF guard, and a fail-closed blank-OCR check. OCR-derived
  parsed evidence remains `agent_contributed` and is capped at confidence `0.5`.
- Production tenancy is governed by
  `docs/contracts/production-tenancy.md`. Production tenants are created only by
  `POST /v1/tenants` with the platform service credential. The route creates
  `tenant.kind='production'`, one active bootstrap admin member, a platform
  identity link, a user-principal member session, and the tenant's propose-only
  BFF service agent with an initial agent token. It seeds no demo data.
- Demo tenancy remains structurally separate. `/v1/demo/provision-run` stamps
  `tenant.kind='demo'`, can never create production tenants, and still returns
  split propose-only agent tokens and user-principal member tokens. Production
  tenants are not eligible for demo cleanup.
- Production member sessions use the exchange model:
  `POST /v1/sessions`, `POST /v1/sessions/refresh`, and
  `DELETE /v1/sessions`. Unlinked platform identities return
  `session_identity_unlinked` and create no tenant, member, link, or session.
  Refresh tokens are hashed at rest, rotated on use, and family-revoked on
  rotated-token reuse.
- Invites are the only way a colleague joins an existing production tenant:
  `POST /v1/members` with `invite:true`, `POST /v1/members/{id}/invites`,
  `DELETE /v1/members/{id}/invites`, and `POST /v1/invites/consume`.
  Invite tokens are returned once, stored hashed, and consume is atomic. Invited
  members have `status='invited'`, cannot approve, cannot hold sessions, and do
  not count toward the last-admin guard.
- Production agent principals are governed by
  `docs/contracts/production-agents.md`. There are two mutually exclusive
  agent-minting paths by tenant kind: `/v1/auth/service-token` remains sandbox
  and testnet only for demo tenants, while production tenants use
  `POST /v1/tenants` for the initial BFF service agent and
  `POST /v1/tenants/{tenant_id}/agent-token` for return-or-rotate. Both paths
  use propose-only agent scopes. Neither path mints approval, execution, sign,
  admin, or member-resolvable credentials.
- `/v1/auth/service-token` remains sandbox and testnet only. It rejects
  `tenant.kind='production'`; it is not a competing production user-session
  exchange path and not a competing production agent path.
- Agent halt is a fail-closed kill-switch. `/v1/agents/{id}/halt` quarantines
  the agent before pausing approved intents in one tenant-scoped transaction.
  The execution outbox worker rechecks the creator agent row with a locking read
  immediately before rail dispatch and parks rows in `reconciling` if the agent
  is missing or no longer active.
- Production boot refuses to start the execution worker without that outbox
  pre-dispatch guard. Operators can restore a halted agent with
  `POST /v1/agents/{id}/restore`; the route only moves `quarantined` to
  `active` and rejects every other state.
- H-09 contribution intake uses contribution-hold naming. The operator release
  route is `POST /v1/agents/{id}/contribution-hold/release`, backed by
  `agents.contribution_hold_cleared_at`. The agent lifecycle state
  `quarantined` is still the kill-switch state and is not renamed.
- DB roles are least privilege by runtime path. `brain_privileged` is a
  deploy seed and verifier fallback role only, not an API runtime role, and it
  cannot insert `audit_events`. Raw worker and ledger projector roles have no
  DELETE grants. The canonical projector has DELETE only on
  `canonical_journal_line`, matching the journal-line replacement path.
- Tenant deletion uses the `brain_tenant_deletion` BYPASSRLS role, but every
  DELETE statement is generated through a checked helper requiring an exact
  `tenant_id`, `owner_id`, or `id` predicate. Predicate-less erasure SQL is a
  test failure.
- API-owned tenant tables apply FORCE ROW LEVEL SECURITY in
  `services/api/migrations/0015_force_rls.sql`: `tenants`,
  `wallet_identities`, `tenant_blob_purge_jobs`,
  `tenant_blob_purge_audit_outbox`, and `email_verifications`.
- HTTP propose surfaces pin agent-token `created_by_agent_id` attribution to
  the authenticated agent principal. Human user sessions without an admin
  override store `created_by_agent_id=null` rather than masquerading as agents.
  A caller-supplied `agent_id` is honored only when the token carries
  `execution:admin`, matching the MCP propose tool. API-key revocation uses the
  canonical agent state machine rather than a raw state update.
- Audit anchor orphan recovery and audit consistency verification run on the
  audit-verifier pool, not the request pool. Both workers emit cycle-failure
  counters and last-success heartbeats. `/internal/audit/health` treats stale
  verifier evidence as critical, so a dead verifier cannot report safe forever.
- The money-path gate fails closed on structural action mismatches:
  `x402_settle` requires settlement context, `escrow_release` requires escrow
  context, and non-canonical policy outcomes other than `allow` or `confirm`
  are rejected. Gate metric sinks are observability only; telemetry failures
  cannot change the deterministic gate decision. Production boot fails if
  behavior-hash flag loading or escrow state loading is missing for live rails.
- Tier 0 Group B closed the hard approval-floor decision for on-chain money
  movement. `onchain_transfer` and `escrow_release` require at least one
  recorded human approval before dispatch even when policy returns `allow`.
  `x402_settle` may execute without per-action approval only when the matched
  signed policy rule sets `onchain_settlement_permitted: true` and
  `x402_autonomous_max_amount: { currency, value }` covering the amount.
  Missing or malformed policy data fails closed to human approval. `x402_settle`
  and `escrow_release` intentionally skip `ledger_reservations`; their spend
  ceilings are the on-chain session-key caps and escrow `remaining` amount.
- Tier 1 Group B applies the same human-approval posture to fiat rails. `wire`
  always requires a recorded human approval when policy allows. ACH and card
  can execute autonomously only when the matched signed policy rule carries a
  covering `ach_autonomous_max_amount` or `card_autonomous_max_amount`. The
  emergency rollback flag is `BRAIN_FIAT_HUMAN_APPROVAL_FLOOR_ENABLED`; it
  defaults true.
- Policy activation runs the production confidence-floor lint. Missing
  `agent.confidence.gte` or a bound `<= 0.5` returns a structured warning by
  default. `BRAIN_POLICY_CONFIDENCE_FLOOR_REJECT=true` turns that same finding
  into an activation reject.

### Deployment

The main workflow runs the Python agents quality gate before image builds:
`ruff`, `black --check`, `mypy --strict brain_agents`, and `pytest`. After the
green main checks, `build_image` builds and pushes two GHCR images tagged with
the GitHub SHA: `ghcr.io/braindotfi/brain-core:<sha>` for the Node runtime and
`ghcr.io/braindotfi/brain-agents:<sha>` for the Python agents runtime. Staging
and production pull the same SHA-tagged images and retag them locally as
`brain-core:prod` and `brain-agents:prod`, so both environments run the same
commit.

Deployment is a single Docker VM per environment. `deploy_staging` runs
automatically on green `main`, connects to `VM_HOST_STAGING` with
`VM_SSH_KEY_STAGING`, uses `.env.staging`, pulls the SHA-tagged images, runs
`tools/migrate up`, reruns `infra/db-roles.sql`, recreates `api`, `worker`, and
`agents`, then smokes the staging health URL with a commit match. Production
deployment is also automated from green `main`: the workflow connects to
`VM_HOST`, uses `.env.prod`, pulls the SHA-tagged images, runs
`tools/migrate up`, reruns `infra/db-roles.sql` before any compose recreate,
recreates `api`, `worker`, and `agents`, and smokes
`https://api.brain.fi/health`.

The old manual staging-to-production promote is retired. The remaining
discipline is the post-deploy probe: verify what is serving, not only what is
merged. For production tenancy changes, operators must probe
`POST /v1/tenants` with `X-Platform-Service-Auth`, confirm the response returns
a user-principal member session, then record the result in the PR or release
notes. A failed migration or smoke check fails the workflow before the deploy is
considered complete.

The VM compose recreate command starts `api`, `worker`, and `agents` with the
`agents` profile. The API reaches the extraction agents at
`DOCUMENT_EXTRACT_AGENT_URL=http://agents:8001`. The agents service uses
`image: brain-agents:${BRAIN_AGENTS_IMAGE_TAG:-prod}` in
`docker-compose.prod.yml`; CI must pull and retag `brain-agents:prod` before
running compose with `--no-build`. Both host env files must carry
`OPENAI_API_KEY`, `DOCUMENT_EXTRACT_AGENT_URL`, `BRAIN_AGENTS_INBOUND_SECRET`,
and the ESP credentials required by outbound email onboarding.

`infra/main.tf` still contains Container Apps wiring from the earlier deploy
model. That wiring is legacy and is not the production source of truth while
the GitHub workflow deploys to Docker VMs.

`/health` includes `commit: process.env.GIT_SHA ?? "dev"` so operators can
confirm which image revision an environment is running. The main workflow passes
the GitHub SHA into container image builds as `GIT_SHA`.

#### Versioning and release tags

The `version` in `GET /health` is derived automatically. Never hand-edited.
`build_image` runs `git describe --tags --always --match 'v*'` and bakes the
result into the image as `SERVICE_VERSION` (Dockerfile `ARG`/`ENV`), so a build
off `main` reports e.g. `v0.0.7-65-gc6674af`: last tier tag, commits since, short
SHA. It cannot drift from what shipped. `SERVICE_VERSION` is therefore NOT set in
`docker-compose.prod.yml`, `.env.prod`, or `.env.staging`. An `env_file`/
`environment:` value overrides the baked image ENV and would re-pin a stale
version, so keep it out of those files.

Humans touch the version only to move a **tier**: tag `main` with `vMAJOR.MINOR.0`
(`v0.1.0`, `v1.0.0`) at a real milestone. The patch/build portion (`-N-gSHA`) is
automatic. Do not cut `v0.0.x` patch tags. The machine fills that in.

Every production promote pushes a lightweight **deploy tag**
`deploy/prod/<utc-timestamp>-<short-sha>` (last step of `promote_production`), so
`git tag --list 'deploy/prod/*'` is a reviewable, timestamped history of what
shipped to `api.brain.fi`. These sit outside the `v*` namespace so they never
become a `git describe` base.

#### Current deployment state

Update this table on every promote.

| Change                                                                  | On main | On staging | On prod (api.brain.fi)                                                                                |
| ----------------------------------------------------------------------- | ------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| Members / approval authority / actor attribution (PR #214, #215)        | Yes     | Yes        | NO, prior probe failed: provision-run 500 internal_server_error before prod migrations were automated |
| Approval-authority gap fixes (PR #216)                                  | Yes     | Yes        | NO, prior probe failed: provision-run 500 internal_server_error before prod migrations were automated |
| Tenant bootstrap member (PR #218)                                       | Yes     | Yes        | NO, prior probe failed: provision-run 500 internal_server_error before prod migrations were automated |
| Bootstrap member session split: member_token in provision-run (PR #219) | Yes     | Yes        | NO, prior probe failed: provision-run 500 internal_server_error before prod migrations were automated |
| Production tenancy, sessions, and invites                               | Pending | No         | No, pending merge and post-deploy `/v1/tenants` probe                                                 |
| Production agent principals                                             | Pending | No         | No, pending merge and post-deploy `/v1/tenants` plus `/v1/tenants/{tenant_id}/agent-token` probe      |

Provision-run returns `tokens.member.token` for user-principal member and
approval workflows and `tokens.agent.token` for propose-only agent workflows.
The agent token returning `403 actor_unresolved` on `/v1/members` is by design
and is a permanent invariant.

Production integrators use `POST /v1/tenants` for first company creation,
`POST /v1/sessions` for platform identity exchange, and
`POST /v1/invites/consume` for invited colleagues. Platform service credentials
identify the platform only; human approval authority always comes from the
member-resolvable user session.

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
