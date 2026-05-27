# RFC 0002 — Self-serve onboarding (open, sandbox-first signup + two-principal identity)

- **Status:** Proposed — design of record for the cold-start onboarding funnel.
- **Date:** 2026-05-27
- **Authors:** ai-assisted
- **Affects:** `services/api` (new public auth/signup surface), `services/execution`
  (agent registration lifecycle), `shared` (auth/JWT, errors, RLS helpers), the
  `agents`/`users`/`tenants` schemas, `infra/db-roles.sql`, and the published API
  spec. Builds on RFC 0001 (M2M commerce) and the existing SIWX flow.

> This RFC opens Brain's **first public, unauthenticated surface** (tenant
> signup). Nothing here weakens the §6 gate, the **propose ≠ execute** boundary,
> the RLS tenant-isolation posture, or the audit invariant. Every new tenant is
> **sandbox-first and fail-closed**: it can read and _propose_ immediately, but no
> money can move until the existing H-24 promotion + external-audit gates clear.
> Each phase ships **shadowed** behind config and is individually revertible.

## 1. Problem — the cold-start gap

Tracing the onboarding path against the code (verified 2026-05-27) shows Brain is
**self-serve _within_ an onboarded tenant, but not for cold start**:

- **No public tenant provisioning.** Tenants are created only by the seed tool
  (`tools/seed-golden-path` → `INSERT INTO tenants`) and at boot. There is no
  `POST /tenants` / `/signup`. (`/agents/register` in the spec is
  `deprecated: true`, not implemented.)
- **First-agent bootstrap is operator-provisioned.** `AgentService.register`
  (`services/execution/src/AgentService.ts`) inserts an agent under
  `withTenantScope(ctx.tenantId)` — it needs an **already-authenticated tenant
  principal**. SIWX-prod (`services/api/src/auth/siwx.ts` →
  `PostgresAgentRegistry.resolveByAddress`) only mints a useful token when an
  `agents` row already exists `WHERE onchain_address = <wallet> AND state =
'active'`. Chicken-and-egg: you need a tenant to make an agent, and (for
  wallet login) an active agent to get a tenant-scoped token.
- **No human credential store.** The `users` table
  (`services/execution/migrations/0005_users.sql`) maps humans to an approval
  `role` (owner/admin/approver/viewer) — but has **no password / credential
  column** and no login endpoint. Human email auth does not exist yet.
- **External-agent on-chain registration is not turnkey.** Rows sit
  `pending_onchain`; the `BrainMCPAgentRegistry` tx + EIP-712 scope attestation is
  scripted/manual and part of RFC 0001's deferred live-wiring.

Net: a developer cannot today sign up, get a tenant, and point a wallet-based
agent at Brain without operator help.

## 2. Design principles (non-negotiable)

1. **Tenant isolation is preserved.** Signup is the _only_ code path that creates
   a new tenant. It is a narrowly-scoped privileged writer; it must never become a
   cross-tenant read/write hole. RLS stays armed + forced on every new table.
2. **No new money path.** Execution still flows `PaymentIntent → §6 gate → audit`
   via `PaymentIntentService`. Signup grants **no** execution capability; sandbox
   tenants' agents are never in `LIVE_AGENTS`; rails fail closed. `propose ≠
execute` is unchanged — the MCP surface still has no execute tool.
3. **Sandbox-first / fail-closed.** New self-serve tenants are flagged `sandbox`.
   They can read + propose (shadow), producing full §6 dry-run gate traces and
   audit, but move no money. Promotion to live is the existing human-gated step.
4. **Audit everything.** `tenant.created`, `user.created`, `auth.login`,
   `agent.registered`, `wallet.linked` all emit audit events.
5. **Least privilege + abuse-resistant.** The public endpoints are rate-limited,
   email-verified before anything sensitive, and reuse the existing JWT/scope
   model — no bespoke crypto.

## 3. The two-principal identity model

A tenant has **two kinds of principal**, both linkable under one tenant:

| Principal                  | Identity                                               | Auth                                                           | What it can do                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Human owner / operator** | email (+ password), optionally a linked wallet         | `POST /v1/auth/login` (email) **or** SIWX (wallet) → human JWT | Tenant management: configure policy, register/manage agents, read via REST, approve payment intents. **No `*:execute`, no `payment_intent:propose` by default.** |
| **Agent (machine)**        | on-chain address registered in `BrainMCPAgentRegistry` | SIWX (wallet) + on-chain scope attestation → agent JWT         | The M2M surface: MCP tools (ledger/wiki reads, `raw.contribute`, `payment_intent.propose`, `agent.action.propose`). Scopes bound by the on-chain `scope_hash`.   |

Key point established during design: **email is for the human account; the
wallet + on-chain attestation is for the agent that acts autonomously.** They are
not interchangeable per-endpoint — the MCP auth chain requires the JWT
`scope_hash` to match the on-chain registry, which is address-based. "Both,
linked" means one tenant can hold an email owner **and** one or more wallet
agents, and the human may _also_ hold a wallet login.

## 4. New public surface (all `skipAuth`, rate-limited, audited)

| Method + path                                         | Purpose                                                                                                                                                                | Auth          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `POST /v1/signup`                                     | Self-provision a tenant + owner user (email). Creates a **sandbox** tenant. Sends an email-verification token.                                                         | none (public) |
| `POST /v1/auth/verify-email`                          | Confirm the owner's email via the token.                                                                                                                               | token         |
| `POST /v1/auth/login`                                 | Email + password → human (owner) JWT, tenant-scoped, management scopes only.                                                                                           | none (public) |
| `POST /v1/auth/siwx/challenge` · `POST /v1/auth/siwx` | **Existing.** Extended so an unknown valid wallet can either (a) **link** to the caller's tenant when invoked with a human JWT, or (b) resolve a human/agent identity. | none / bearer |
| `POST /v1/tenants/{id}/wallets`                       | Link a wallet to the tenant as a **human** login or as an **agent** identity.                                                                                          | owner JWT     |
| `POST /v1/agents`                                     | Owner registers an agent (address + requested scope) → creates `pending_onchain` + enqueues the on-chain relay.                                                        | owner JWT     |

The legacy `POST /execution/agents/register` is superseded by `POST /v1/agents`
(kept until clients migrate). SIWX stays the wallet entry point.

## 5. Data model

Additive, back-compat migrations (forward-compatible per the migrate tool):

- **`tenants`** — add `sandbox BOOLEAN NOT NULL DEFAULT FALSE` (self-serve signup
  sets it `TRUE`; existing/seeded tenants stay non-sandbox). Add `created_via TEXT`
  (`'seed' | 'self_serve' | 'admin'`) for provenance. RLS unchanged (`id =
app.tenant_id`).
- **`users`** — add `password_hash TEXT` (argon2id; NULL for wallet-only humans),
  `email_verified_at TIMESTAMPTZ`, `status TEXT` (`'pending' | 'active' |
'disabled'`). RLS unchanged.
- **`wallet_identities`** (new) — `address TEXT`, `tenant_id`, `principal_type
TEXT ('human' | 'agent')`, `user_id`/`agent_id` FK, unique on `address`. Lets
  SIWX resolve a wallet → (tenant, principal) for **both** humans and agents
  (today only agents resolve). RLS by `tenant_id`; the cross-tenant
  address→tenant lookup uses the existing `brain_privileged` reader path SIWX
  already runs under.
- **`email_verifications`** (new) — `token_hash`, `user_id`, `expires_at`,
  `consumed_at`. Tokens are single-use, short-TTL, stored hashed.
- **`agents`** — reuse the existing `state` lifecycle: `pending_onchain → active`.
  Add `onchain_attestation_attempts` + `last_attestation_error` for the relayer.

## 6. Tenant-isolation safety (the critical section)

Creating a tenant is inherently cross-tenant: the request has **no** `tenant_id`
yet, so it cannot run under the normal `withTenantScope` predicate. The signup
writer is therefore privileged and must be **surgically narrow**:

1. **Mint the new tenant id first**, then perform the inserts with
   `app.tenant_id` **set to the freshly-minted id** — so the existing
   `tenants`/`users` RLS write policies (`id = app.tenant_id` /
   `tenant_id = app.tenant_id`) pass for the new tenant and **only** the new
   tenant. The writer never reads or writes any other tenant's rows.
2. The privileged connection is used **only** for: `INSERT` one `tenants` row,
   `INSERT` one owner `users` row, `INSERT` the email-verification token, and (on
   wallet link/agent register) one `wallet_identities` / `agents` row — all keyed
   to the new tenant id. No `SELECT *` across tenants, no update of foreign rows.
3. **Uniqueness is enforced at the DB** (`UNIQUE(email)` globally for owner login;
   `UNIQUE(address)` on `wallet_identities`) so signup cannot hijack or collide
   with another tenant's identity.
4. A dedicated invariant test (in `tests/invariants/`) asserts: a freshly
   signed-up tenant can see **only** its own rows, and the signup path cannot be
   coerced into writing another tenant's `tenant_id`.

This mirrors how the SIWX address→agent lookup and the audit emitter already
operate as sanctioned `brain_privileged` cross-tenant paths (CLAUDE.md §1).

## 7. Security model

- **Abuse / DoS:** per-IP + per-email rate limits on `/signup`, `/auth/login`,
  `/auth/siwx`; exponential backoff + lockout on repeated login failures; optional
  proof-of-work / CAPTCHA hook on `/signup`. Email verification gates any
  sensitive action (agent registration, wallet linking).
- **Passwords:** argon2id, per-user salt, never logged; a hashed, single-use,
  short-TTL reset token flow. Wallet-only humans have `password_hash = NULL`.
- **Wallet proof:** SIWX already proves key control via EIP-4361 signature over a
  server nonce (Redis, 5-min TTL, single-use) — reused unchanged.
- **Secrets:** the JWT signing key (`AUTH_SIGN_KEY`) stays in Azure Key Vault; no
  new long-lived secret. The relayer signer (Phase C) is KMS-backed and
  fail-closed (see §8).
- **No PII on-chain:** unchanged — only the agent address + `bytes32 scope_hash`
  reach `BrainMCPAgentRegistry`; email/password never touch the chain.

## 8. On-chain agent registration — off-chain pending + async relayer (D-3)

Decision: **register off-chain immediately, confirm on-chain asynchronously.**

1. `POST /v1/agents` validates the owner JWT + requested scope, computes the
   `scope_hash`, inserts the `agents` row `state = 'pending_onchain'`, and
   enqueues a `brain.agents.onchainRegister` job. Signup latency is decoupled from
   chain confirmation.
2. A relayer worker submits the `BrainMCPAgentRegistry` scope-attestation tx via a
   **KMS-backed signer** and, on confirmation, flips the row to `active`
   (the state SIWX-prod requires). Until the signer/RPC is configured the relayer
   **fails closed** (the row stays `pending_onchain`, the agent cannot get a live
   token) — mirroring the rail boot-fence in RFC 0001.
3. **Swappable:** the same `agents` lifecycle supports the gasless-at-signup or
   user-submits-the-tx variants later without a schema change — only the relay
   strategy differs.

The KMS signer construction + Base RPC wiring is the deferred live-wiring step
(as with the escrow/x402 rails and the `resolveEscrowState` reader).

## 9. Sandbox → live promotion

A self-serve tenant is `sandbox = TRUE`. Sandbox semantics:

- Its agents are **never** auto-added to `LIVE_AGENTS`
  (`services/agent-router/src/promotion-config.ts`); a financial proposal
  terminates `shadow_completed` and moves no money (RFC 0001 §`/agents/run`).
- Rails fail closed regardless (`rails/stubs.ts` throws in production).
- Promotion to a live, money-moving tenant remains the existing human/business
  decision behind `scripts/check-promotion-readiness.mjs` (H-24) **and** the
  external contract audit — explicitly out of scope for self-serve.

So "open signup" is safe **by construction**: the worst a new tenant can do is
read its own (empty) ledger and generate shadow proposals.

## 10. Sequencing (shadow-first, small reviewed PRs)

- **Phase A — this RFC.** Design of record. _(doc PR)_
- **Phase B — tenant provisioning + human email auth.** `/signup`,
  `/auth/login`, `/auth/verify-email`; `tenants.sandbox` + `users` auth columns +
  `email_verifications`; the narrow privileged signup writer; the isolation
  invariant test. **No agent, no money.** Behind `BRAIN_SELF_SERVE_SIGNUP` flag,
  default off.
- **Phase C — agent registration + relayer interface.** `POST /v1/agents`,
  `pending_onchain` lifecycle, the `brain.agents.onchainRegister` job + a
  fail-closed relayer interface (signer deferred).
- **Phase D — wallet identities + SIWX linking.** `wallet_identities`, extend
  SIWX to resolve humans + link wallets; unify the address→principal lookup.
- **Phase E — API spec + SDK + docs.** Update `Brain_API_Specification.yaml`,
  regenerate `@brain/sdk`, write an onboarding quickstart.

Each phase is additive, flag-gated, fails closed, and lands green
(`lint && typecheck && test:coverage`, plus the new invariant test).

## 11. Decisions (decision log)

| #       | Decision                    | Resolution                                                                                                                                                            |
| ------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O-1** | Signup gating               | **Open, sandbox-first.** Anyone can provision a tenant; it lands sandbox/fail-closed; real money stays behind H-24 + audit.                                           |
| **O-2** | Identity model              | **Two principals, linked:** email (+password) for the human owner/management; SIWX wallet + on-chain attestation for the agent. A human may also link a wallet login. |
| **O-3** | On-chain agent registration | **Off-chain `pending_onchain` + async KMS relayer** (fail-closed; deferred signer). Swappable to gasless-at-signup / user-submits later.                              |
| **O-4** | New tenant default posture  | **`sandbox = TRUE`**; existing/seeded tenants stay non-sandbox (column defaults FALSE).                                                                               |
| **O-5** | Human login scopes          | Management/read + approve only — **never** `*:execute` or `payment_intent:propose` by default (those belong to agents).                                               |

## 12. Non-goals (this RFC)

- Real-money go-live for self-serve tenants (audit + H-24 gated).
- Production KMS relayer signer construction / funded gas wallet (deferred wiring).
- A dashboard UI / hosted web app (this is the API + auth layer only).
- Billing / plans / quotas beyond basic rate limits.
- SSO / OAuth / social login (email + wallet only for now).

## 13. New error codes + audit events

- **Errors** (`shared/src/errors.ts` — add code + `HTTP_STATUS_BY_CODE`):
  `signup_email_taken` (409), `signup_disabled` (403, when the flag is off),
  `auth_invalid_credentials` (401), `auth_email_unverified` (403),
  `auth_rate_limited` (429), `wallet_already_linked` (409),
  `agent_onchain_pending` (409, acting before confirmation).
- **Audit events:** `tenant.created`, `user.created`, `user.email_verified`,
  `auth.login`, `auth.login_failed`, `wallet.linked`, `agent.registered`,
  `agent.onchain_confirmed`.
