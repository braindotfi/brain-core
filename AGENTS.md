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

Durable "Continue with Demo" tenants use `POST /v1/tenants` with
`demo_seed: true`. They remain `tenant.kind='production'` for session exchange
and production agent tokens, but receive the Brightline demo ledger, policy,
agent, pending Needs Review proposals, and fake-connected source rows before the
create response returns.

Tenant API keys are first-class bearer credentials for the commercial read API.
Only `ledger:read`, `audit:read`, and `governance:read` are issuable today.
Plaintext `brain_sk_test_` and `brain_sk_live_` secrets are returned once, while
`api_keys` stores only the server-peppered SHA-256 digest. Gateway auth compares
digests in constant time, rejects revoked or expired keys, applies per-key rate
limits, updates `last_used_at`, and attributes request audit events with
`key_id`.

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

Audit anchor event scans must use `AUDIT_ANCHOR_FROM_BLOCK` in staging and
production. If unset, the broadcaster and reconciler use bounded lookback
instead of genesis and log a warning. Event scans are chunked by
`AUDIT_ANCHOR_EVENT_SCAN_MAX_BLOCKS`. Insufficient publisher wallet funds throw
`InsufficientAnchorFundsError`, leave the anchor pending for retry, emit the
critical wallet metric, and must never mark the row `reverted`.

Audit anchor publishing uses `BrainAuditAnchor.anchorBatch` on Base Sepolia to
collapse each bounded publisher cycle to a single transaction where possible.
The contract cap and default scheduler cap are 50 rows per batch, chosen to keep
gas headroom while draining tenant-scale backlogs. Mainnet anchoring remains
fenced until the additive batch function is externally audited. The one-time
backlog drain script defaults to dry-run and must stop before spending when the
configured wallet floor or max-spend budget would be crossed.

Every service-owned table with a `tenant_id` column must enable and force
Postgres row-level security and define at least one tenant policy. The
`check-rls-coverage` guard scans all `services/*/migrations/*.sql` files as one
migration set, so coverage may be added in a later migration than the table
creation. Any exemption must be listed in the guard allowlist with a
human-readable reason.

Production DB and object-store credentials have no safe defaults.
`docker-compose.prod.yml` requires every DB role password plus
`MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` at compose interpolation time.
`shared/src/config.ts` also refuses to boot in `NODE_ENV=production` when any
consumed DB URL password, `BRAIN_*_DB_PASSWORD`, `POSTGRES_PASSWORD`, MinIO
credential, or S3/Azure blob secret is empty or uses a known weak default. The
same check warns, but does not throw, in `NODE_ENV=staging`.

Legacy VM `.env.staging` and `.env.prod` files missed
`BRAIN_MCP_READER_DB_PASSWORD` when credential hardening made it mandatory.
Use the production-gated `ops-mcp-reader-db-password.yml` workflow to inspect
or repair that one credential without logging it, then apply `db-roles` to
align the existing reader role.

Before any image pull or compose recreate, staging and production deploy
workflows run `scripts/check-required-compose-secrets.sh` on the target VM.
It derives `${VAR:?message}` requirements from `docker-compose.prod.yml` and
checks enabled conditional boot fences without printing values. This catches
missing `AUTH_COOKIE_SECRET` and `BRAIN_MCP_READER_DB_PASSWORD` before a deploy
can change runtime state.

Supply-chain CI runs on every pull request and main push: `pnpm audit` and
tfsec fail on high or critical findings, CodeQL uses security-extended queries
for JavaScript, TypeScript, and Python, and Trivy scans both production images.
PR scans use images built once in the scanning job; main scans the exact GHCR
images before staging deploy. Dependabot updates npm and GitHub Actions weekly.
Any scanner ignore requires a documented reason and expiry date. The current
`.trivyignore` entries are Debian 12 advisories with no vendor fix at the time
of scanning and expire on 2026-09-02; reassess them when refreshing base images.

Wiki and Assistant question answers treat retrieved evidence as untrusted tenant
data. Evidence blocks are wrapped in a per-request random boundary, evidence
text is facts to cite and never instructions to obey, and answer serialization
fails closed to the grounded-answer fallback when the parsed or stored answer
contains raw internal JSON, boundary tokens, or prompt fragments. Evidence ids
remain subset-filtered against the retrieved tenant-scoped rows. `/v1/wiki/question`
returns `answered` separately from prose; deterministic transaction count, total,
and average questions return exact Ledger results with transaction evidence.

Fiat rails have a default-on human approval floor. `wire` always requires a
recorded human approval when policy allows. ACH and card can execute
autonomously only when the matched signed policy rule carries a covering
`ach_autonomous_max_amount` or `card_autonomous_max_amount`.

Counterparty trust enforcement at section 6 check 5.25 is gated by
`BRAIN_TRUST_GATE_ENABLED` and defaults off. When enabled, `paused` denies with
`counterparty_trust_paused`; missing, malformed, or unloadable trust state
denies with `counterparty_trust_unknown`. Before any environment enablement,
run `scripts/ops/report-counterparty-trust-gate-impact.ts` in read-only mode
and complete a focused section 6 re-audit.

Policy activation lints for `agent.confidence.gte > 0.5`. The default is a
structured warning; `BRAIN_POLICY_CONFIDENCE_FLOOR_REJECT=true` makes it a hard
activation reject.

H-09 contribution intake uses contribution-hold naming:
`POST /v1/agents/{id}/contribution-hold/release` and
`agents.contribution_hold_cleared_at`. The agent lifecycle state `quarantined`
remains the kill-switch state.

Member mutations emit `member.changed` audit events with before and after
envelopes and return `audit_id`. Awaiting second approval emits
`proposal.awaiting_second_approval`; the outbound webhook allowlist also accepts
the old payment-intent alias for compatibility.

## Copy Rules

No em dashes, no ampersands outside brand names, no emojis in docs, comments, or
commit messages.
