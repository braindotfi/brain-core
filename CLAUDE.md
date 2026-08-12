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
- `services/auth`: the OAuth 2.0 authorization server at `AUTH_ISSUER`
  (`auth.brain.fi`), a standalone Fastify deployable (see OAUTH-AS-PLAN.md).
  It serves RFC 8414 metadata and JWKS discovery, and after Phase 4 is the sole
  JWKS source for every service that verifies tokens. A discovery-only build
  (one constructed without an OAuth core) returns 503 from
  `/authorize` and `/token`. Phase 2a increment 2 (AUTH-PATHS-PLAN.md section
  2, "Path 1") adds human authentication: `GET/POST /login`, `/set-password`,
  `/forgot-password`, server-rendered HTML, stateless `__Host-brain_as`
  session cookie plus a pre-auth CSRF carrier (both `shared/src/auth/hmac-token.ts`),
  reusing `email_verifications` verbatim (no migration). Still no
  `/authorize`/`/token`/PKCE/consent -- that is the OAuth core, a later
  increment. Two DB pools: `brain_auth` (`BRAIN_AUTH_DB_URL`, tenant-scoped)
  and `brain_resolver` (`BRAIN_RESOLVER_DB_URL`, the pre-tenant email lookup),
  plus `brain_auth_audit_writer` (`BRAIN_AUTH_AUDIT_DB_URL`) for `auth.login`
  / `auth.password_set` / `auth.password_reset_requested` audit events. Runs
  as its own process with its own explicit env (DB role URLs, `AUTH_SIGN_KEY`,
  `AUTH_COOKIE_SECRET`, `EMAIL_ENDPOINT`/`EMAIL_API_KEY`/`EMAIL_FROM`), not the
  full `.env.prod` secret set (no `env_file:`), since it is a public
  browser-facing origin.

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
- Audit events expose `event_type`, `category`, `severity`, and `actor_ref`.
  `flagged` is reserved for risk events that require attention. `wiki.question`
  emits `assistant_activity` with severity `info` and includes the original
  question text at `inputs.question`.
- A policy allow that creates an already-approved payment intent emits
  `payment_intent.auto_approved`, distinct from the human
  `payment_intent.approved` event. Successful payment completion transitions
  the linked execution from `in_flight` to `completed` in the same tenant
  transaction that marks the intent executed.
- Wiki and Assistant question answers treat retrieved evidence as untrusted
  tenant data. Evidence blocks are wrapped in a per-request random boundary,
  evidence text is facts to cite and never instructions to obey, and answer
  serialization fails closed to the grounded-answer fallback when the parsed or
  stored answer contains raw internal JSON, boundary tokens, or prompt fragments.
  Evidence ids remain subset-filtered against the retrieved tenant-scoped rows.
  `/v1/wiki/question` returns `answered` separately from prose. Deterministic
  transaction count, total, average, and bounded transaction, cash-flow, or
  invoice listing questions return exact Ledger results with cited records.
  `GET /v1/wiki/suggested-questions` derives tenant-aware suggestions only from
  that deterministic registry. Each registered intent supplies its eligibility
  query, and eligible intents are ranked by tenant-local invocation count.
  Named-counterparty payable and receivable totals, overdue customer invoice
  listings, payroll-obligation totals, largest-payable answers, new-vendor
  listings, and month-scoped or trailing-monthly net cash-flow totals use
  deterministic tenant-scoped Ledger queries. Named-counterparty questions
  fail safely without generative fallback when the counterparty is missing,
  ambiguous, has the wrong direction, or is part of a compound question.
  A payable question for a customer with no open payables but open AR invoices
  states both directions, using authoritative AR `ledger_invoices` rows rather
  than implying no overall relationship exists.
  Counterparty evidence includes the persisted `trust_status`; trusted,
  paused, acknowledged, and unreviewed vendor-list questions use a
  deterministic tenant-scoped route rather than generative retrieval.
- Wiki pages are a projection, so an orphaned page is pruned rather than
  retried forever. `wiki_pages` is both the work list and the output store of
  the regeneration worker: `runWikiRegenerationCycle` regenerates every slug it
  finds, a failed render never reaches the upsert so `rendered_at` never
  advances, and no tenant exceeds the 100-row page batch, so a page whose
  Ledger subject was deleted was retried on every cycle indefinitely. Three
  data-repair migrations delete `ledger_obligations` rows
  (`services/raw/migrations/0025`, `0026`, `services/ledger/migrations/0043`)
  and none of them touch `wiki_pages`; nothing in the runtime deleted a page
  either. This was not an RLS visibility artifact: `wiki_pages.tenant_id` and
  `ledger_obligations.owner_id` are both matched against the same
  `app.tenant_id` by the same NOBYPASSRLS `brain_wiki_reader` role. Entity
  generators now signal a missing subject with the typed
  `wiki_subject_not_found` (`subjectNotFound` in
  `services/wiki/src/pages/types.ts`), and the worker prunes the page through
  `WikiPageService.deletePage`, emits `wiki.page.pruned`, and counts
  `brain.wiki.regeneration.page_pruned.count`. Only that code prunes: any other
  render failure, such as an embedding outage, still warns and leaves the page
  alone, so a transient fault can never delete memory. Pruning is recoverable
  because the next upload projection re-derives the slug and renders the page
  again. Metrics are tagged by `page_type` and error `reason` only, never by
  tenant or slug, which are unbounded cardinality, and a healthy cycle costs
  one summary log line.
- Every service-owned table with a `tenant_id` column must enable and force
  Postgres row-level security and define at least one tenant policy. The
  `check-rls-coverage` guard scans all `services/*/migrations/*.sql` files as
  one migration set, so coverage may be added in a later migration than the
  table creation. Any exemption must be listed in the guard allowlist with a
  human-readable reason.
- Proposal read contracts are documented in
  `docs/contracts/proposals-read-model.md`. `/v1/proposals` and
  `/v1/proposals/{id}` keep their compact fields and also expose
  `stored_action_type`, `details`, `policy`, `presentation`, and
  `available_decisions`. Public proposal types are `bill_management`,
  `cash_forecast`, `collections`, `compliance`, `debt_optimization`,
  `dispute`, `financial_health`, `fraud_anomaly`, `payment`,
  `personal_budget`, `purchase_advisor`, `reconciliation`, `revenue_intel`,
  `savings`, `subscription`, `tax_prep`, `travel_finance`, `treasury`, and
  `vendor_risk`. Stored action names map through an explicit resolver; ambiguous
  names such as `notify`, `escalate`, `create_task`, and `recommend_action`
  resolve through the agent role instead of action-name guessing.
- Tenant provisioning must create one active bootstrap admin member in the same
  transaction as the tenant row. The bootstrap member uses all approval domains,
  a per-item limit of `9223372036854775807`, no second-approver threshold, and
  `active=true`. Self-serve signup uses the owner user id as the member id.
  Demo provision-run uses the minted bootstrap user id as the member id and
  returns a separate user-principal member session for member and approval
  workflows. Missing email is written as `bootstrap+<tenantId>@brain.invalid`
  and can be patched by an admin later.
- Tenant offboarding is governed by `docs/contracts/tenant-offboarding.md`.
  Export is `POST /v1/tenants/{id}/export`, status is
  `GET /v1/tenants/{id}/export/{job_id}`, and download is
  `GET /v1/tenants/{id}/export/{job_id}/download`. Export, download, and
  deletion are user-principal and own-tenant only. Exports expire after the
  configured retention horizon, default 7 days, and expired archive blobs are
  purged by object path.
- Tenant isolation is governed by `docs/contracts/tenant-isolation.md`.
  Tenant-scoped request-path reads must run through RLS with
  `withTenantScope`; id-in-path routes must return not-found or denied for
  cross-tenant ids and must never return another tenant's data.
- Idempotency and request correlation are governed by
  `docs/contracts/idempotency-correlation.md`. Consequential POST retries with
  the same tenant, `Idempotency-Key`, and body return the original stored
  response without re-running the handler. `X-Request-Id` is the request
  correlation id and is propagated to audit events and outbound webhook
  payloads as `correlation_id`.
  `POST /v1/governance/reports/snapshot` is BFF-only and uses a route-local
  idempotency wrapper against the same store, scoped by explicit `tenant_id` and
  the full snapshot request parameters.
- Unmatched high-risk `agent_action` proposals from fraud and vendor-risk
  workflows fail to human review, not silent rejection. The policy VM still
  default-denies unmatched rules; `PolicyService.evaluateLegacy` converts only
  scoped high-risk proposal fallthroughs to `confirm` with a signer requirement.
- Collections Agent proposals are deduped per `invoice_id`: an overdue sweep
  must never leave more than one unresolved proposal open for the same invoice.
  Later sweeps refresh the pending row, while the guarded production cleanup
  marks historical duplicates `superseded` with an audit link to the retained row.
  The authorized production cleanup run `31434998851` superseded 6,950 rows,
  left 943 pending Collections proposals, and left zero duplicate groups. Run
  cleanup in `report` mode before any future apply.
  Proposal freshness cannot depend on a successful agent run: the overdue
  scanner claims a 24h `agent_trigger_cooldowns` row before calling
  `AgentRunService.run`, and that run has several early terminal returns
  after the cooldown is claimed but before `proposeAction` is reached
  (missing handler, missing action, a shadowed `payment_intent`,
  `bundle.critical_missing`, `executionMode` of `reject` or `notify_only`,
  payload validation failure). Every one of those burns the cooldown without
  refreshing the pending proposal, so a persistent condition (an agent stuck
  in `notify_only`, or an invoice that is never in `ledger_invoices` at all)
  freezes the proposal indefinitely while the underlying invoice keeps aging
  (#534, #535). The Collections proposal reconciler
  (`services/api/src/agents/collections-proposal-reconciler.ts`,
  `BRAIN_COLLECTIONS_RECONCILE_*` config) fixes this from the proposal side:
  it discovers tenants with pending Collections proposals through the
  BYPASSRLS tenant-deletion pool, then reconciles each proposal against the
  current `ledger_invoices` row through the tenant-scoped `brain_app` pool,
  under the same advisory lock `AgentService.propose()` uses. A proposal
  whose invoice row is absent is superseded; a proposal whose stored
  `days_overdue` has drifted is refreshed in place through the shared
  `refreshCollectionsActionDaysOverdue` helper and re-evaluated policy. The
  reconciler deliberately supersedes only when the invoice row is missing
  entirely; a paid, cancelled, or disputed invoice, or one whose due date
  moved into the future (a corrected or renegotiated term, not drift), is a
  separate product decision and is only counted, not acted on. The per-tenant
  batch is a work list, not a scan window: the "needs action" filter (invoice
  missing, or collectible and overdue and drifted) runs in the tenant-scoped
  SQL itself, ordered `updated_at ASC, id ASC`, so `current` and
  `non_collectible` rows never occupy a batch slot and the reconciler cannot
  starve behind them the way the batch's own motivating bug (943 pending rows
  for one tenant) would otherwise recreate. A row the reconciler skips because
  refreshing it would leave a non-`pending` status
  (`policy_outcome_not_pending`) still gets an `updated_at` touch with no
  content change, so it rotates to the back of the work list instead of
  reappearing at the front every cycle.
- Every persisted `agent_runs` terminal `missing_evidence` or `notify_only`
  outcome emits `agent.run.missing_evidence` or `agent.run.notify_only` through
  the audit emitter. The event carries the run id, trigger, resolved action,
  known entity references, and either missing evidence or notification reason;
  `agent.action.proposed` remains the terminal event for proposal-created runs.
- Approval actors resolve through `ActorResolver` only. Session surfaces derive
  the actor from authenticated server context and ignore any actor field in the
  payload. Session actor resolution requires `principal_type=user`; agent
  principals are propose-only and never member-resolvable. API machine
  credentials must assert an actor and are recorded as `tenant_asserted`; Slack
  and Teams resolve through identity links; email uses signed proposal-bound
  tokens.
- MCP exposes proposal read, proposal decision, and evidence resolution tools.
  `proposals.decide` is a human decision surface: user principals delegate to
  the same `ProposalDecisionService` as HTTP, while agent principals still fail
  `ActorResolver` with `actor_unresolved`.
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
- Outbound webhooks are at-least-once over committed audit events. The fast path
  dispatches after `AuditEmitter.emit`; `webhook_delivery_receipts` records
  successful endpoint-event delivery, `webhook_dead_letters` records failed
  attempts, and the webhook dispatch worker reconciles forwarded audit events
  that have neither record. Customers must dedupe on webhook `id`.
- Forwarded webhook events include proposal decisions, agent proposals, raw
  ingest new/deduplicated, raw extraction status changes, raw source status
  changes, payment terminal outcomes (`payment_intent.executed`,
  `payment_intent.failed`, `payment_intent.reconciling`), payment lifecycle
  events, member changes, ledger create/update events, and policy evaluation.
  `raw.ingest.completed` is stale and must not be used.
- The platform repo must conform to `docs/contracts/members-attribution.md`.
  Platform-side member UI is mock-only until it is wired against the core
  `/v1/members` API and core approval responses.
- BrainMVB must use `docs/api-surface.brainmvb.json` as the machine-readable
  integration contract for stable brain-core endpoints. The artifact enumerates
  non-feature-gated deployed API routes including auth mode, required scope,
  route-local enforcement status, request and response shape, and examples.
  Scope checks are enforced by route handlers through `requireScope`; HEAD does
  not have a central gateway route-to-scope matrix.
  API-key auth and API-key management remain code-gated behind
  `BRAIN_API_KEY_AUTH_ENABLED`, even though staging enables that flag today.
  Production API-key authentication is deliberately disabled pending staging
  acceptance and auth-surface review; no production enablement date is
  committed. They are tracked as feature-gated rather than stable in the
  BrainMVB surface.
- Governance Phase 1 exposes BFF-only `GET /v1/governance/agents`,
  `GET /v1/governance/agents/{agent_id}`,
  `PATCH /v1/governance/agents/{agent_id}`, and
  `GET /v1/governance/reports`. Governance Phase 2 adds
  `POST /v1/governance/reports/snapshot` and
  `GET /v1/governance/reports/{report_id}` for immutable report snapshots.
  These routes are mounted with `skipAuth` and `optionalAuth`, so they accept
  either the cross-tenant `X-Platform-Service-Auth` shared secret or a
  tenant-scoped bearer principal (a Brain API key) carrying `governance:read`,
  both checked by `assertPlatformCredential`. A bearer principal is bound to
  its own tenant: a `tenant_id` query or body param naming a different tenant
  is rejected with `auth_tenant_mismatch`, and an absent one defaults to the
  principal's tenant. Only the platform-service secret is genuinely
  cross-tenant and requires an explicit `tenant_id`. Agent creation is not
  exposed. Reports are built from audit events, join `policy_decisions` when
  historical rows have `policy_decision_id`, and return
  `decision_data_status=unavailable` for rows that lack a native outcome or a
  resolvable policy decision. Forward-going policy, gate, payment-intent
  creation, and agent-proposal audit emitters add native nullable
  `policy_check_id` and `outcome` fields when those values are known. Policy
  check catalog publication is deferred pending a future security and legal
  review. External governance agent registration is removed from the current
  backlog until a concrete product trigger exists.
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
- AR-sourced Ledger invoice and receivable-obligation rows carry the positive
  `metadata.scenario="ar"` marker. `GET /v1/ledger/obligations` returns
  metadata and supports `direction=receivable`, `scenario=ap|ar`, `limit`, and
  opaque cursor pagination through `next_cursor`. With no explicit direction,
  `scenario=ar` selects receivable rows and `scenario=ap` selects payable rows.
  `GET /v1/ledger/invoices` is the complete receivables inventory; the
  receivable-obligation filter only contains rows with an obligation projection.
  Clients must not infer AR by treating every non-AP row as receivable.
- Manual counterparty create and edit are identity-only. Payment rail fields
  such as IBAN, account number, routing, SWIFT, BIC, wallet, and bank details
  are rejected with `payment_fields_not_allowed` and never write
  `ledger_counterparty_payment_instructions`.
- Unknown identity body fields return `unknown_field`; server-controlled trust
  fields return `field_not_editable`.
- Tenant API keys are core-owned and first-class bearer credentials.
  `api_keys` stores only the SHA-256 digest of
  `BRAIN_API_KEY_PEPPER + "." + plaintext_secret`; plaintext
  `brain_sk_test_` or `brain_sk_live_` secrets are returned exactly once from
  issue and rotate responses. Tenant admins manage them through
  `POST /v1/tenants/{id}/keys`, `GET /v1/tenants/{id}/keys`,
  `POST /v1/keys/{id}/rotate`, and `DELETE /v1/keys/{id}`. Current scopes are
  `ledger:read`, `audit:read`, and `governance:read`. Authentication looks up
  key candidates by display prefix and last four characters, then compares the
  peppered SHA-256 digest with a constant-time comparison. Revoked keys and keys
  with past `expires_at` are rejected. Per-key rate limiting and
  `last_used_at` tracking are applied at the gateway. Request-path audit events
  include nullable `key_id`; session-authenticated and pre-enforcement events
  keep `key_id` null. Per-key usage is exposed through
  `GET /v1/tenants/{id}/usage?window=30d&environment=sandbox&key_id=...`.
- Production tenant creation is also available at
  `POST /v1/orgs/{orgId}/tenants`, using the same persistent production tenant
  flow as `POST /v1/tenants`.
- Platform identity links are globally unique for `surface='platform'`.
  `POST /v1/tenants` and `POST /v1/orgs/{orgId}/tenants` preflight that global
  link and translate a concurrent insert race to
  `409 tenant_identity_already_linked` with `error.details.tenant_id`; clients
  must reattach through the session and agent-token routes rather than retrying
  tenant creation.
- Policy activation blocks on every linter ERROR finding, not only the
  confidence floor. Activation previously computed the other eight ERROR codes
  (`auto_no_amount_cap`, `auto_no_counterparty_constraint`,
  `auto_no_verified_counterparty`, `no_approval_path_high_value`,
  `unsupported_currency`, `invalid_approval_role`, `auto_no_risk_bound`,
  `broad_any_auto`) and discarded them, so an unbounded auto-executing `any`
  money-movement rule could be activated as long as some other rule carried a
  confidence floor. The rollback flag is `BRAIN_POLICY_LINT_REJECT`; it
  defaults true, and a `tenant.kind='production'` tenant always enforces
  regardless of the flag. `POST /policy/:tenant_id/lint` applies the identical
  options so it is a faithful preview of activation rather than reporting WARN
  for what activation rejects. Consequence to know: 14 of the
  `services/internal-agents/src/*/policy.template.json` reference templates are
  NOT activatable under this rule (they declare `applies_to: ["any"]` with
  `execute: "auto"`, and `any` matches `outbound_payment` in the VM, so the
  finding is a true positive). Their current ERROR codes are pinned in
  `services/internal-agents/src/policy-template-lint-inventory.test.ts` so the
  list shrinks deliberately; narrowing each agent's authority envelope is an
  open product decision.
- All three activation paths enforce identically: `POST /policy/:tenant_id/sign`,
  `POST /policy/:tenant_id/compose` (structural validation only; compose writes
  `draft`, not `active`), and `POST /v1/demo/policy/activate`
  (`services/api/src/demo/policy-activate-route.ts`, extracted out of `main.ts`
  so it is unit-testable). The demo route used to run only a shallow
  `typeof version === "number" && Array.isArray(rules)` check before inserting
  `state = 'active'` directly, so a caller holding `policy:write` in
  `BRAIN_DEMO_MODE` could activate the exact unbounded auto-executing `any`
  rule the lint gate above exists to reject. It now calls
  `validatePolicyDocument` and the same blocking-findings logic sign uses,
  factored into `runActivationLintGate` (`services/policy/src/linter.ts`) so
  the two routes cannot drift. The route's own `DEMO_POLICY` fixture required
  the same treatment `buildDefaultPolicyDocument` (`onboarding/provision.ts`)
  already uses: its `outbound_payment` / `onchain_tx` auto rules became
  `confirm` because this route has no seeded counterparty data to scope a
  `counterparty.in` allowlist to, and `agent.risk_level.lte` is fail-closed
  against the unset `risk_level` a demo-created PaymentIntent carries.
  `tools/seed-golden-path/src/cli.ts` (a separate raw-SQL `policies.state =
'active'` writer used to seed a fresh testnet deploy) got the identical
  content fix plus a `validatePolicyDocument` + `runActivationLintGate` check
  before its insert. `services/api/src/demo/brainsaas-seed.ts` (also raw SQL)
  now calls `validatePolicyDocument` and had its own unbounded
  `treasury-auto-onchain` catch-all rule tightened to `confirm`; its
  `ap-auto-approved-within` rule still carries two pre-existing lint findings
  (`no_approval_path_high_value`, `auto_no_risk_bound`) that were deliberately
  left unenforced there because fixing them safely needs BrainSaaS-side
  coordination (wiring real `risk_level` signals into payment-intent creation,
  or redesigning the $50k auto ceiling) rather than a brain-core-only change.
- Moving `scripts/demo/golden-path.sh`'s payment rule from `auto` to `confirm`
  (above) exposed two more gaps in the golden-path flow, both now fixed.
  First: `GET /v1/demo/token` (main.ts) mints a `type: "user"` session for the
  fixed `DEMO_GOLDEN_USER` in `DEMO_GOLDEN_TENANT`
  (`services/api/src/demo/golden-tenant.ts`), but nothing seeded a `members`
  row for that id, so `ActorResolver`'s session lookup always returned null
  and every approval attempt failed `actor_unresolved` regardless of the
  token's scopes; `tools/seed-golden-path/src/cli.ts` now seeds a bootstrap
  admin member for that exact id (via the same `insertBootstrapAdminMember`
  helper `onboarding/provision.ts` uses, now re-exported from `@brain/api`),
  so the SAME demo token both proposes and approves, matching how a real
  member session would. Second: policy `require: "owner_approval"` can never
  be satisfied by any real approval, because the section 6 gate's check 11
  (`approval_granted_when_required`, `shared/src/gate/gate.ts`) matches
  `decision.required_approvers` against the literal `members.role` string
  that signed, and `MemberRole` (`services/execution/src/members/types.ts`)
  is only `admin | approver | viewer`; there is no `owner` role a member can
  actually hold. `require: "single_signer"` has the same problem for its
  `"signer"` label. This was a pre-existing, dormant defect (the confirm-tier
  rules in these demo policies already used `owner_approval` before this fix;
  golden-path.sh just never exercised a confirm outcome before), not
  introduced by moving the payment rule to `confirm`; the demo policies here
  were changed to `require: "admin_approval"` to match a role a seeded member
  can actually hold. The same defect also affected `onboarding/provision.ts`'s
  `buildDefaultPolicyDocument` (`require: "single_signer"`) and
  `brainsaas-seed.ts`'s `require: "owner_and_cfo"` / `"owner_approval"`; see
  the next bullet for the durable fix, landed separately from this one.
- Three independently-defined approver-role vocabularies used to disagree:
  `MemberRole` (`services/execution/src/members/types.ts`, `admin | approver
| viewer`), what `authorizeApproval` ever persists as `approvals.approver_role`
  (`admin | approver`, never `viewer`), and the policy linter's own
  `DEFAULT_ROLES` (`services/policy/src/linter.ts`), which used to invent
  `owner`, `finance`, and `controller` on top of the real set. That let the
  linter's `invalid_approval_role` check bless a `require` clause (e.g.
  `owner_approval`, `owner_and_cfo`) the gate could never satisfy. Worse, for
  the `signer` generic-slot token both `single_signer` and the policy VM's own
  confirm-tier default use, the section 6 gate's check 11 did a naive literal
  match against `decision.required_approvers` while
  `ApprovalService.hasRequiredRoleQuorum` had the real generic-slot semantics,
  so `require: "single_signer"` (the default policy for every self-serve
  production tenant, via `onboarding/provision.ts`) could never clear the gate
  no matter who approved. Fixed by one canonical vocabulary,
  `APPROVER_ROLE_TOKENS` (`admin | approver | signer`, `shared/src/gate/approverRoles.ts`),
  that the linter's `DEFAULT_ROLES` is now pinned to, and one shared
  `hasRequiredRoleQuorum` (same file) that both the gate's check 11 and
  `ApprovalService` call, so they cannot drift apart again. Seeded policies
  using the unsatisfiable roles were moved to the canonical set:
  `brainsaas-seed.ts`'s `owner_approval` rules became `admin_approval`, and
  its `owner_and_cfo` dual-control rule became `admin_and_approver` to
  preserve the two-distinct-roles intent. `single_signer` / `["signer"]`
  policies (`provision.ts`, the VM's confirm-tier default, and the
  high-risk fallback in `services/policy/src/service.ts`) needed no content
  change; they were already correct and are now actually satisfiable.
  `scripts/check-invariants.mjs` pins both the linter's vocabulary and the
  one-quorum-implementation property. Note: this does not retroactively fix
  already-active `owner_approval` policy rows in a live database; the linter
  only blocks re-activation, it does not migrate stored rows.
- Submitted policy documents are structurally validated by
  `validatePolicyDocument` (`services/policy/src/validate.ts`) at compose, lint,
  simulate-historical, and again at activation against the stored row. It
  rejects rule shape errors, duplicate rule ids, malformed amount literals,
  out-of-range unit-interval bounds, unsupported spend and tx window names,
  unknown `when` keys, message-template placeholders outside
  `allowed_variables`, and dangling `counterparty.in` / `counterparty.not_in`
  list references. Unsupported cron syntax is rejected by
  `validateCronExpression` rather than partially matched: the documented matcher
  subset is `*` plus comma-separated integers only, so ranges, steps and names
  now fail at validation instead of silently evaluating wrong.
- The signed-policy chain of trust is enforced on READ as well as write.
  `getActive` recomputes the canonical content hash and throws
  `policy_not_active` on drift, deliberately failing closed rather than
  returning null (null would read as "no policy" and get misreported as
  `policy_not_found`). The storage half is in `infra/db-roles.sql`: blanket
  UPDATE on `policies` is revoked from every runtime role and re-granted as the
  column list `state, signers, activated_at, deactivated_at, onchain_tx,
onchain_version`, so `content` and `content_hash` are immutable after INSERT;
  `policy_decisions` is insert-only to every runtime role. `brain_tenant_deletion`
  keeps its DELETE for erasure. Both properties are asserted by
  `check-invariants`.
- Because that read check is fail-closed, any `policies` row whose
  `content_hash` was not written by `contentHash` is fatal on deploy. Two demo
  seeders wrote `sha256(JSON.stringify(doc))` (insertion order) instead of the
  canonical sorted-key hash; both are fixed, but rows they already wrote must be
  re-stamped before deploying, with
  `node scripts/ops/repair-policy-content-hash.mjs` (dry run by default). It
  refuses to re-stamp a row with signatures, since those were collected over the
  stored digest. **This is CI-enforced, not operator-trusted**: both
  `deploy_staging` (`main.yml`) and `promote-prod.yml` run a "Policy
  content-hash repair gate" step (dry run, `docker compose run --rm` through
  the `migrate` service) right after the required-secret presence check and
  before rollback tagging, image pull, migrations, or any compose recreate,
  and fail the workflow closed if any row is still outstanding. It runs
  through `migrate`, not `api`: `policies` is under FORCE RLS and `api`
  connects as the NOBYPASSRLS `brain_app` role, so a check run through `api`
  would silently see zero rows and always pass. `migrate` already carries
  `DATABASE_URL` for the Postgres bootstrap superuser (`brain`), which
  bypasses RLS unconditionally, matching the script's own requirement for the
  owner/migration role. See `docs/r03-staging-deploy-runbook.md`.
- Audit anchor coverage is derived per tenant from `MAX(period_end)` over its
  non-reverted anchors, not from a fixed `now - AUDIT_ANCHOR_INTERVAL_MS`
  window. The fixed window left every event emitted while the process was down
  (any deploy or restart) permanently unanchored and invisible. A 7 day
  catch-up clamp bounds one cycle's tree, and
  `brain.audit.anchor.oldest_unanchored_age_seconds` makes the backlog
  observable. `brain_audit_publisher` holds SELECT on `audit_anchors` for the
  coverage join. The window itself is computed by the pure `nextAnchorWindow`
  helper (`services/audit/src/anchorWindow.ts`, re-exported from `@brain/audit`)
  so the scheduler (`services/api/src/main.ts`) and the on-demand
  `POST /audit/anchor/publish` route derive it identically: `periodStart` is
  `max(coveredTo + 1ms, oldestUnanchored)`, not `coveredTo + 1ms` alone -- a
  tenant whose next unanchored event is more than 7 days past `coveredTo`
  (a long quiet period) would otherwise clamp to an always-empty window and
  never advance `covered_to` again.
- Anchor publisher event scans must use `AUDIT_ANCHOR_FROM_BLOCK` in staging
  and production. If it is unset, the broadcaster and reconciler use a bounded
  lookback window (`AUDIT_ANCHOR_FROM_BLOCK_LOOKBACK_BLOCKS`) and log a warning
  rather than scanning from genesis. Event scans are chunked by
  `AUDIT_ANCHOR_EVENT_SCAN_MAX_BLOCKS` to fit range-limited Base RPC providers.
  The broadcaster checks wallet balance before `writeContract`; insufficient
  funds throws `InsufficientAnchorFundsError`, leaves the anchor pending for
  retry, emits `brain.audit.anchor.publisher_wallet_insufficient_funds.count`,
  and never marks the row `reverted`.
- Audit anchor publishing uses `BrainAuditAnchor.anchorBatch` on Base Sepolia.
  The scheduler first creates each tenant's one-row anchor record under
  tenant-scoped RLS, then broadcasts bounded batches of up to
  `AUDIT_ANCHOR_BATCH_SIZE` rows, default 50, so a normal cycle is one on-chain
  tx instead of one tx per tenant. Database-linked Base Sepolia receipts from
  36 transactions and 189 roots measured on 2026-08-11 ranged from 47,325 to
  73,620 gas per tenant root, with a weighted average of 51,474. This preserves
  the per-tenant `_published` SSTORE and `AnchorPublished` event required for
  tenant-level on-chain lookup. This receipt measurement is not a full
  publisher-wallet cost guarantee while wallet-to-anchor reconciliation remains
  under investigation. Metrics include
  `brain.audit.anchor.pending_backlog_depth`, `brain.audit.anchor.batch_size`,
  and `brain.audit.anchor.batch_tx.count`. Mainnet anchoring remains fenced
  until the additive batch function completes external audit.
- Audit anchoring is explicit per tenant through `tenants.audit_anchor_mode`.
  Production tenants use `onchain`; demo and sandbox tenants use `db_only` and
  retain the append-only database hash chain without publishing roots to Base
  Sepolia. The scheduled publisher, retry queue, and on-demand publish routes
  all reject `db_only` from on-chain work. `GET /v1/audit/anchor/latest`
  returns `anchoring_mode` and `guarantee`, so clients must display database
  hash-chain status distinctly from an on-chain anchor.
- The publisher closes an on-chain cycle when accumulated logical tenant roots
  reach `AUDIT_ANCHOR_TRIGGER_TENANT_ROOTS` (default 50) or the oldest pending
  or eligible root reaches `AUDIT_ANCHOR_MAX_WAIT_MS` (defaulting to the legacy
  `AUDIT_ANCHOR_INTERVAL_MS`, one hour), whichever comes first. It evaluates
  those conditions every `AUDIT_ANCHOR_CHECK_INTERVAL_MS` (default 60 seconds).
  `BRAIN_ONCHAIN_MIN_PRIORITY_FEE_GWEI=0.025` and
  `BRAIN_ONCHAIN_MIN_MAX_FEE_GWEI=0.20` are the durable Base Sepolia anchor fee
  floors. They were lowered on 2026-08-11 after receipts showed the prior
  0.05 gwei priority floor, rather than observed 0.006 to 0.021 gwei network
  conditions, was setting the normal 0.055 gwei effective price. The priority
  floor retains margin above the observed reward range; the broadcaster still
  takes the maximum of these floors and the network estimate, so they do not
  cap fees during a real spike.
- `reverted` is a per-ROW terminal status and only genuinely applies to the
  single-anchor path (`publishPendingAnchor`), where one row is one
  transaction. Every reachable `anchorBatch` revert reason (`NotPublisher`,
  `BatchTooLarge`, `BatchLengthMismatch`, a failed gas estimate, or a mined
  revert of the batch tx) is a property of the transaction, not of any one
  row, so `publishPendingAnchorBatch` and the batch broadcaster
  (`services/api/src/anchorBroadcaster.ts`) surface those as `unresolved`
  instead: the row is left `pending` for a later cycle (same posture
  `InsufficientAnchorFundsError` already takes), counted separately in the
  summary, and emits `brain.audit.anchor.batch_unresolved.count`. The same
  status covers a row whose already-anchored on-chain status could not be
  confirmed this cycle (its `AnchorPublished` event wasn't found in the scan
  window) -- that failure is isolated per row so one poison row cannot abort
  the rest of the batch (the retry query is `ORDER BY created_at ASC`, so a
  stuck poison row would otherwise always be back at the front of every
  cycle). `createPendingAnchor` logs loudly (`console.error`, not silent) if
  a recomputed window ever matches an existing terminally-reverted anchor
  row, since that row's `period_end` never advances `covered_to` and would
  otherwise recur every cycle with nothing in the logs to show it; the
  operator's recovery is a deliberate manual decision, not an automatic
  retry.
- Published anchors are re-proved, so tail truncation is detectable. The fork,
  gap, genesis and content-hash checks all pass if the newest events of a
  tenant's chain are deleted. `verifyAnchorRoots` recomputes each confirmed
  anchor's Merkle root from the rows currently in its window and records a
  durable `audit_integrity_findings` row on mismatch, paging oldest-first
  through its own `audit_verifier_checkpoint` cursor so every anchor is
  eventually re-proved rather than only the newest slice. No migration: both
  tables are keyed by `verifier_name`. Pass state rolls into
  `/internal/audit/health` beside the content verifier.
- Inclusion proofs resolve against the anchor window CONTAINING the event
  (`findAnchorForEvent`), in both `GET /audit/event/:id` and the strict-proof
  path in `services/api/src/proof/fetchProofSources.ts`. Both previously used
  the newest anchor only, so every historical event returned a null root and an
  empty proof despite having been anchored.
- `POST /audit/export` returns 501 and names `POST /v1/tenants/{id}/export`. It
  used to return 202 and a `job_id` that no worker, table or status route could
  redeem. The SDK method surfaces the server error rather than a fabricated job.
- `POST /audit/anchor/publish` derives its per-tenant cooldown from the latest
  `audit_anchors` row rather than in-process state, so it survives restart, is
  not per-replica, and a failed publish no longer consumes the window.

Pending Dmitriy sign-off

- Demo-to-production transition for tenants and keys: archive, delete, or
  migrate demo-mode tenants and keys when an org transitions to production.
- Demo tenant expiry behavior for in-flight API-key requests after the roughly
  30-minute session window expires: immediate rejection or a defined grace
  period.
- Counterparty identity edits require a user principal, preserve the previous
  name as an alias on rename, keep aliases append-only, reject rename
  collisions with `name_conflict`, and emit `ledger.counterparty.updated`.
  New manual vendor creates emit `vendor.created` for vendor risk routing.
- Raw exposes async document extraction jobs. `POST /v1/raw/:raw_id/extract`
  requires `raw:write` and enqueues or re-enqueues an `extraction_jobs` row
  instead of calling the Python agent on the request thread. `GET
/v1/raw/:raw_id/extraction` requires `raw:read` and returns the latest job
  status, parsed id, confidence, and error. Tenants can opt in to automatic
  extraction for uploaded document artifacts through `raw_tenant_settings`.
  Connector-sourced artifacts are not auto-extracted. If
  `DOCUMENT_EXTRACT_AGENT_URL` is unset, ingest does not enqueue automatic jobs;
  any queued job the worker sees is marked failed with `dependency_unavailable`.
  Transient extractor failures are retried with bounded exponential backoff via
  `next_attempt_at`; permanent failures and exhausted retries are terminal
  `failed` jobs. Source connector sync requests persist a tenant-scoped
  `raw_source_sync_jobs` row; clients poll
  `GET /v1/sources/:source_id/sync/:job_id` for status.
- A repaired external extractor credential does not make already exhausted jobs
  retry forever. Recovery migrations may requeue only the recorded terminal
  `document extraction agent unreachable` outage state against the retained
  bytes. Payroll upload recovery removes only stale rebuildable canonical and
  compact rows when both the old per-employee parser output and current
  run-level output exist, then replays the current parsed row. Historical raw
  bytes and parsed evidence remain intact. The `brain_ledger_projector` role
  needs SELECT, INSERT, and UPDATE on both `ledger_counterparties` and
  `ledger_obligations`; missing runtime grants block compact AP/AR projection
  even when canonical projection succeeds.
- Plaid, Stripe, and Finch parser rows no longer write Ledger entities directly
  from `LedgerService.normalizeFromRaw`. Their `plaid_tx_v1`, `stripe_v1`, and
  `finch_payroll_v1` extractors validate shape and return no direct rows.
  Canonical projection writes connector accounts, transactions, counterparties,
  and obligations to `canonical_account`, `canonical_transaction`,
  `canonical_counterparty`, and `canonical_obligation`; Ledger then projects
  those records through the canonical projection workers. Per-row validation
  skips inside an otherwise successful connector projection emit
  `brain.canonical.connector.skipped_row.count` with the skip reason.
- Owner password-login tokens now include `raw:read` and `raw:write` so a
  verified self-serve tenant owner can upload documents, trigger extraction, and
  read advisory ledger state. Owner tokens still exclude
  `payment_intent:propose`, `payment_intent:execute`, and `execution:propose`.
  Production self-serve signup sends verification tokens through the API ESP
  client using `EMAIL_ENDPOINT`, `EMAIL_API_KEY`, and optional `EMAIL_FROM`.
  When tokens are hidden and ESP credentials are missing, API boot fails before
  routes are registered.
- The document extraction agent keeps deterministic text extraction first for
  CSV, plain text, XLSX, and text-layer PDFs. Customer-asserted CSV uploads
  declare one of `counterparties`, `payables_invoices`,
  `receivables_invoices`, `payroll_runs`, or `tax_obligations` through the Raw
  envelope `object_type`; those rows are parsed and canonically projected with
  `customer_asserted` provenance. Invoice direction comes only from that
  declared type, never from a filename or inferred content. Unsupported or
  undeclared CSV schemas fail with `raw_source_unsupported` and never fall
  through to the LLM extractor. The staging-only
  `staging-customer-asserted-csv-smoke.yml` workflow provisions an isolated
  tenant and verifies all five schemas, AP of `$74,620.25`, AR of `$76,200.00`,
  and resolved invoice counterparty names. Image uploads and scanned PDFs
  fall back to OCR through `OPENAI_OCR_MODEL` (default `gpt-4o`) with a 10 MB
  input guard, a 5 page PDF guard, and a fail-closed blank-OCR check. OCR-derived
  parsed evidence remains `agent_contributed` and is capped at confidence `0.5`.
  The agents container must be healthy before staging or production deploys
  complete. Its `BRAIN_API_TOKEN` is a golden-tenant, agent-principal JWT with
  only `raw:write`; rotate it without logging the value through
  `ops-rotate-agents-api-token.yml` before its one-year expiry.
  Known upload PDFs are classified before parser selection: bank statement PDFs
  must clear the bank-statement confidence floor, while AR aging and payroll
  PDFs emit `document_records_upload_v1`. Legacy `doc_obligation_v1` rows still
  emit the upload-projected hook so compact AP/AR rebuilds and projection status
  are not stranded. Payroll aggregation emits only dated pay runs; context-less
  summary rows are not payable obligations.
- Production tenancy is governed by
  `docs/contracts/production-tenancy.md`. Production tenants are created only by
  `POST /v1/tenants` with the platform service credential. The route creates
  `tenant.kind='production'`, one active bootstrap admin member, a platform
  identity link, a user-principal member session, and the tenant's propose-only
  BFF service agent with an initial agent token. When the platform sends
  `demo_seed: true`, the same durable production tenant is also seeded with the
  Brightline demo ledger, policy, agent, pending Needs Review proposals, and
  fake-connected source rows before the 201 response. This is the supported
  persistent "Continue with Demo" path; it does not change `tenant.kind`, add a
  TTL, or make the tenant eligible for demo cleanup. `demo_seed: true` does not
  persist the demo fixture bytes as raw artifacts. The staging-only
  `staging-document-fixture-smoke.yml` workflow provisions an isolated
  non-demo-seeded production tenant, uploads its core-owned source-equivalent
  tax, wallet, payroll, and AR fixtures through `/v1/raw/ingest`, and waits for
  each to reach `projection_status=projected`. It is the brain-core-only
  extraction smoke path and must not be repurposed to change ordinary demo
  provisioning.
- Demo tenancy remains structurally separate. `/v1/demo/provision-run` stamps
  `tenant.kind='demo'`, can never create production tenants, and still returns
  split propose-only agent tokens and user-principal member tokens. Production
  tenants are not eligible for demo cleanup.
- BrainSaaS demo provisioning also seeds demo-only fake connected
  `raw_sources` rows for the MVP source categories. These rows overlap the
  Brightline document seed data, expose `disconnectable:false`,
  `disconnect_hidden:true`, and `sync_disabled:true` in metadata, and are
  excluded from raw source sync by `demo_seed_kind='fake_connected_source'`.
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
- Section 6 check 5.25 counterparty trust enforcement is feature-gated by
  `BRAIN_TRUST_GATE_ENABLED`, which defaults false. When enabled, `paused`
  denies with `counterparty_trust_paused`; missing, malformed, or unloadable
  trust state denies with `counterparty_trust_unknown`. Run
  `scripts/ops/report-counterparty-trust-gate-impact.ts` in read-only mode and
  complete a focused section 6 re-audit before enabling any environment. The
  report classifies every affected paused-counterparty group by tenant kind and
  sandbox posture; only production, non-sandbox groups require named review
  before an enablement flip.
- Tier 0 Group B closed the hard approval-floor decision for on-chain money
  movement. `onchain_transfer` and `escrow_release` require at least one
  recorded human approval before dispatch even when policy returns `allow`.
  `x402_settle` may execute without per-action approval only when the matched
  signed policy rule sets `onchain_settlement_permitted: true` and
  `x402_autonomous_max_amount: { currency, value }` covering the amount.
  Missing or malformed policy data fails closed to human approval. `x402_settle`
  and `escrow_release` intentionally skip `ledger_reservations`; their spend
  ceilings are the on-chain session-key caps and escrow `remaining` amount.
  The session-key half of that ceiling is only real when the key is granted in
  the right cap mode. `BrainSmartAccount` has three: NATIVE meters `msg.value`
  and forbids calldata outright, ERC20 meters the decoded token amount and binds
  the recipient, and CALL meters the uint256 word at a grant-time
  `capAmountOffset`. An escrow release is a contract call with `value = 0`, so it
  MUST be granted in CALL mode with `capAmountOffset = 36` (the `amount` word of
  `release(bytes32,uint256)`). Under the older single-mode model it metered
  `msg.value` and therefore always measured zero, so the documented ceiling did
  not exist for `escrow_release` at all. There is no longer any un-metered call
  path: every mode either forbids calldata or names where the amount lives.
  The escrow `remaining` half is enforced by gate check 6.6, which also binds the
  escrow's `token` to the configured settlement asset. Without that binding the
  amount comparison was meaningless, because the resolver scales every amount
  with the settlement asset's decimals and `BrainEscrow.lock` accepts any ERC-20.
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

Deployment is a single Docker VM per environment. `deploy_staging` (in
`main.yml`) runs automatically on green `main`, connects to `VM_HOST_STAGING`
with `VM_SSH_KEY_STAGING`, uses `.env.staging`, pulls the SHA-tagged images,
runs `tools/migrate up`, reruns `infra/db-roles.sql`, recreates `api`,
`worker`, `agents`, `auth`, and `surface-gateway`, then smokes the staging
health URL with a commit match.

Production promotion is manual: `.github/workflows/promote-prod.yml` is a
separate `workflow_dispatch` workflow, run by hand from the Actions tab, so
promoting production is decoupled from the per-commit `main.yml` run (that
run's `environment: production` approval used to sit inside the same
concurrency group as `build_image`/`deploy_staging`, so the oldest queued run
held the approval slot and approving it could ship a stale SHA). It takes an
optional `sha` input; left blank, it resolves the SHA currently live on
staging (`GET https://staging-api.brain.fi/health`) and promotes that. It
still requires the `production` environment approval, connects to `VM_HOST`,
uses `.env.prod`, pulls the resolved SHA's images, runs `tools/migrate up`,
reruns `infra/db-roles.sql` before any compose recreate, recreates `api`,
`worker`, `agents`, `auth`, and `surface-gateway`, then reloads the Caddy
config, and smokes `https://api.brain.fi/health` plus `auth`'s `/healthz`
for a commit match against the resolved SHA. The auth probe goes over SSH to
the container's loopback port rather than `https://auth.brain.fi/healthz`,
deliberately: it asserts that the container is serving the expected commit,
not that the edge in front of it is healthy, so a Caddy or DNS problem does
not fail the promote for an unrelated reason. (`auth.brain.fi` does resolve
and serve publicly as of 2026-08-03; the loopback probe is a scoping choice,
no longer a DNS workaround.)

**JWKS sidecar retirement (Phase 4, OAUTH-AS-PLAN.md §8).** `docker-compose.prod.yml`'s
standalone `jwks` service (the `tools/static-jwks` sidecar on :8085) has been
retired: `auth` is now the single JWKS source, and `AUTH_JWKS_URL` for every
consumer (`api`, `worker`, `surface-gateway`, and `auth`'s own unused
placeholder) points at `http://auth:3000/.well-known/jwks.json`.

Hard precondition, not a footnote: `services/auth/src/main.ts` `process.exit(1)`s
in production when `EMAIL_ENDPOINT`/`EMAIL_API_KEY` or the three `BRAIN_*_DB_URL`
role URLs are missing. No ESP is provisioned in `.env.prod` as of this writing,
so `auth` cannot currently boot in prod. **Do not run this cutover until an ESP
is provisioned and `auth` has been confirmed healthy on the target VM** --
flipping `AUTH_JWKS_URL` at a crash-looping `auth` container breaks every
token verification in production at once.

Once that precondition holds, both `main.yml` and `promote-prod.yml` recreate
`auth` alone first and gate on its `/healthz` (bounded retry loop) before
touching anything that verifies tokens against it -- see the "Migrate +
recreate auth on VM" / "Wait for auth healthy on VM" / "Recreate
api/worker/agents/surface-gateway on VM" steps in each workflow. The cutover
on a given VM is, in order:

1. Confirm `auth` is healthy on that VM (the workflow step above does this
   automatically; manually it is `docker compose ... ps auth` and/or curling
   its `/healthz`).
2. Recreate `api`, `worker`, and `surface-gateway` (the workflow step above
   already does this, after step 1 passes) so they pick up the new
   `AUTH_JWKS_URL`.
3. Verify a token still verifies (mint with `tools/dev-token`, hit an
   authenticated route) -- the `kid` is unchanged since `auth` and `jwks`
   shared `AUTH_SIGN_KEY`, so this should be a no-op cutover.
4. Only then remove the orphan: the `brain-prod-jwks` container is not
   removed by `up -d` alone once its service block is deleted from compose --
   the project just stops managing it. Run `docker rm -f brain-prod-jwks` as
   an explicit operator step. Do not reach for `--remove-orphans` on a bare
   `up -d` instead: with no service list it also evaluates `postgres` and
   `minio` (the same shape as the 2026-07-24 MinIO downgrade outage this repo
   already documents), would run `migrate`/`db-roles` as recreated containers
   instead of `run --rm`, and may treat the profile-gated `agents` container
   as an orphan too.

What step 4's ordering preserves: while `jwks`'s container still exists,
reverting `AUTH_JWKS_URL` in compose back to `http://jwks:8085/...` and
recreating the verifiers is a live rollback path. Removing the orphan before
step 3 confirms tokens still verify throws that rollback away with nothing to
fall back to.

The remaining discipline is the post-deploy probe: verify what is serving,
not only what is merged. For production tenancy changes, operators must probe
`POST /v1/tenants` with `X-Platform-Service-Auth`, confirm the response returns
a user-principal member session, then record the result in the PR or release
notes. A failed migration or smoke check fails the workflow before the deploy is
considered complete.

The VM compose recreate command starts `api`, `worker`, `agents`, `auth`, and
`surface-gateway` with the `agents` profile. The API reaches the extraction agents at
`DOCUMENT_EXTRACT_AGENT_URL=http://agents:8001`. The agents service uses
`image: brain-agents:${BRAIN_AGENTS_IMAGE_TAG:-prod}` in
`docker-compose.prod.yml`; CI must pull and retag `brain-agents:prod` before
running compose with `--no-build`. Both host env files must carry
`OPENAI_API_KEY`, `DOCUMENT_EXTRACT_AGENT_URL`, `BRAIN_AGENTS_INBOUND_SECRET`,
and the ESP credentials required by outbound email onboarding.

Production DB and object-store credentials fail closed in two places. First,
`docker-compose.prod.yml` requires every database role password and MinIO root
credential through `${VAR:?message}` interpolation. Second,
`shared/src/config.ts` refuses to boot in `NODE_ENV=production` when any
consumed database URL password, `BRAIN_*_DB_PASSWORD`, `POSTGRES_PASSWORD`,
MinIO credential, or S3/Azure blob secret is empty or uses a known weak default
such as the role name, `brain`, `postgres`, `changeme`, or `password`.
`NODE_ENV=staging` logs the same findings at warn level instead of throwing so
operators can rotate values without taking staging down. Required production
variables are: `POSTGRES_PASSWORD`, `BRAIN_APP_DB_PASSWORD`,
`BRAIN_PRIVILEGED_DB_PASSWORD`, `BRAIN_WIKI_DB_PASSWORD`,
`BRAIN_MCP_READER_DB_PASSWORD`, `BRAIN_RAW_WORKER_DB_PASSWORD`,
`BRAIN_CANONICAL_PROJECTOR_DB_PASSWORD`, `BRAIN_LEDGER_PROJECTOR_DB_PASSWORD`,
`BRAIN_EXECUTION_WORKER_DB_PASSWORD`, `BRAIN_AUDIT_VERIFIER_DB_PASSWORD`,
`BRAIN_AUDIT_PUBLISHER_DB_PASSWORD`, `BRAIN_RESOLVER_DB_PASSWORD`,
`BRAIN_TENANT_DELETION_DB_PASSWORD`, `BRAIN_SURFACE_GATEWAY_DB_PASSWORD`,
`BRAIN_SURFACE_GATEWAY_AUDIT_DB_PASSWORD`, `BRAIN_AUTH_DB_PASSWORD`,
`BRAIN_AUTH_AUDIT_DB_PASSWORD`, `MINIO_ROOT_USER`, and
`MINIO_ROOT_PASSWORD`.

Existing VM environments store those deployment credentials in `.env.staging`
and `.env.prod`, rather than in repository secrets. The production-gated
`ops-mcp-reader-db-password.yml` workflow inspects or safely repairs the
`BRAIN_MCP_READER_DB_PASSWORD` entry without logging its value, then reapplies
the `brain_mcp_reader` role through `db-roles`. The credential hardening that
made this value mandatory exposed a legacy provisioning omission: the reader
role already existed, but the historical VM env files had never received its
password. Before a promote that adds a compose-required secret, run a
pre-promote required-secret presence check for both environments.

MinIO root credentials are also consumed by the API and worker as their
S3-compatible object-store credentials. If `.env.staging` or `.env.prod`
changes either `MINIO_ROOT_USER` or `MINIO_ROOT_PASSWORD`, run the
production-gated `ops-reconcile-minio-credentials.yml` workflow for that
environment before accepting uploads. It recreates MinIO with the configured
credentials, verifies bucket access through `minio-setup`, and proves the real
`/v1/raw/ingest` path with an ephemeral demo tenant. Recreating API or worker
alone does not update MinIO's running root credentials.

Every staging deploy and production promote runs
`scripts/check-required-compose-secrets.sh` on the VM after syncing compose
files but before rollback tagging, image pull, migrations, or compose recreate.
It derives unconditional requirements from `${VAR:?message}` interpolation in
`docker-compose.prod.yml`, reports only missing variable names, and also checks
the enabled conditional boot fences for API keys, service tokens, demo
provisioning, external agents, and surface integrations. It also checks
that the target environment's `CORS_ALLOWED_ORIGINS` contains
`https://app.brain.fi`. During the public-host transition, set
`CORS_ALLOWED_ORIGINS=https://mvp.brain.fi,https://app.brain.fi` plus every
other existing origin in both `.env.staging` and `.env.prod` through the
gated VM configuration process. This is not a repository-managed secret or
env-file change. The preflight intentionally blocks a deploy if the new origin
is absent; remove the guard only in the later, deliberate mvp retirement
change. Use the target-bounded `ops-cors-allowed-origins.yml` workflow to
append `https://app.brain.fi` without removing existing origins, recreate only
the API CORS consumer, and verify the public preflight. Its production target
uses the GitHub `production` environment gate.
Auth's
`AUTH_SIGN_KEY`, `AUTH_COOKIE_SECRET`, `EMAIL_ENDPOINT`, and `EMAIL_API_KEY`
are compose-required as well as boot-fenced. This would have stopped both the
missing `AUTH_COOKIE_SECRET` and missing `BRAIN_MCP_READER_DB_PASSWORD`
incidents before any image pull.

Immediately after that secret check, both workflows also run a "Policy
content-hash repair gate": `scripts/ops/repair-policy-content-hash.mjs`
(dry run, no `--apply`) via `docker compose run --rm --no-deps` through the
`migrate` service, still before rollback tagging, image pull, migrations, or
compose recreate. It runs through `migrate`, never `api`: `api`'s
`DATABASE_URL` is the NOBYPASSRLS `brain_app` role and `policies` is under
FORCE RLS, so a check that ran through `api` would issue an unscoped SELECT
that silently returns zero rows and pass even when repair is needed.
`migrate` already carries `DATABASE_URL` for `brain`, the Postgres bootstrap
superuser (`docker-compose.prod.yml`'s `postgres` service: "migrate connects
as this role"), which bypasses RLS unconditionally -- the owner/migration
role the script's own header requires -- and that credential is already in
`migrate`'s environment from compose, so nothing is passed on a command
line. The gate fails the workflow closed if any `policies` row still carries
a pre-6b544ed non-canonical `content_hash` (see the policy-layer section
above), and skips with a message rather than failing only when `postgres`
itself is not running (genuine cold start, nothing to repair against a
nonexistent table). Repair is a deliberate operator action (`--apply`, run
ahead of the deploy) -- the gate never mutates data itself, matching the
no-manual-DB-surgery default of failing rather than silently re-stamping in
CI.

Supply-chain controls run on every pull request and main push. `pnpm audit`
fails on high and critical dependency advisories, tfsec scans `infra/` at the
same threshold, and CodeQL runs security-extended JavaScript, TypeScript, and
Python analysis. Pull requests build each production Dockerfile once and scan
both resulting images with Trivy. Main scans the exact core and agents images
already pushed to GHCR before staging deploy. Dependabot checks npm and GitHub
Actions weekly. Any future dependency or Trivy ignore must document its reason
and expiry date. `.trivyignore` currently contains only no-fix Debian 12 base
image advisories, each with a documented reason and 2026-09-02 expiry; reassess
them when refreshing the base images.

`ops-counterparty-trust-smoke.yml` is a production-gated mutable smoke for the
counterparty trust-state API. It creates an isolated seeded tenant, calls all
four user-authenticated transitions through the public API, and verifies both
the returned state and five audit events. Keep `prod-tenant-diagnostics.yml`
read-only; do not add mutable checks to that workflow.

`staging-diagnostics.yml` is staging-only and read-only. Its
`tenant-identity-lookup` diagnostic accepts only one validated platform user
UUID or email, joins `member_identity_links` to the matching member and tenant,
and reports only `tenant.created` and `tenant.demo_seeded` audit events. Its
`wiki-question-trace` diagnostic accepts exactly one validated tenant ID plus
an event ID, UTC time bound, or bounded question substring, then prints the
matching stored `wiki.question` audit inputs and outputs in a read-only
transaction. Neither diagnostic permits arbitrary SQL or VM writes.

Caddy config (`Caddyfile`, `docker-compose.caddy.yml`) is repo-tracked and
shipped by CI, but only to the **production** VM (`promote-prod.yml`), and
that vendored `Caddyfile` was read directly off the prod box: it carries only
`api.brain.fi`, `mcp.brain.fi`, and `auth.brain.fi`. It is deliberately NOT
shipped by `main.yml`'s staging deploy. The staging VM (`VM_HOST_STAGING`) is
a different box with its own host-only Caddyfile carrying a
`staging-api.brain.fi` block that is not in this repo and has no backup;
staging's `docker compose ... -f docker-compose.caddy.yml` invocations rely on
that file already being present on the box from manual setup, never on CI
having shipped it. Do not add Caddyfile/docker-compose.caddy.yml sync or a
Caddy reload step to `main.yml`.

Production Caddy is composed into the same Docker project as `api`, `auth`, and
`surface-gateway`. The repo-tracked `Caddyfile` reaches `api:3000` and
`auth:3000` through Docker DNS on the internal compose network, while same-host
operator and health probes can still use the host loopback binds. Do not publish
app services on all host interfaces in production. Keep app-service host ports
loopback-only, e.g. `127.0.0.1:3000:3000`, `127.0.0.1:3002:3000`, and
`127.0.0.1:3003:3000`. Caddy's `80:80` and `443:443` are the public entry
points.

Caddy applies HSTS (`max-age=31536000; includeSubDomains`), `nosniff`, deny
framing, strict-origin referrer policy, and removes the `Server` header for
`api.brain.fi`, `mcp.brain.fi`, and `auth.brain.fi`. HSTS is safe because Caddy
is the HTTPS edge for these sites. Do not add `preload` unless the domains are
intentionally submitted to the browser preload list. `/v1/docs*` also receives
the Scalar-compatible CSP already used by the API docs route; keep it aligned
with `services/api/src/docs/routes.ts`.

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
`deploy/prod/<utc-timestamp>-<short-sha>` (last step of `promote-prod.yml`'s
`promote` job), so
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
