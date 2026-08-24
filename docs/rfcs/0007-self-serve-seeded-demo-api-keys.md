# RFC 0007. Self-serve seeded demo tenants and sandbox Raw API keys

- **Status:** Proposed. Specification only, no implementation.
- **Date:** 2026-08-24
- **Affects:** BrainMVB signup and tenancy orchestration, `services/api`
  production tenancy, tenant API keys, shared scope policy, migrations, API
  specification, SDK types, and operational promotion workflows.
- **Related:** RFC 0002, `docs/contracts/production-tenancy.md`, PR #396, and
  PR #483.

## 1. Current-state findings

### 1.1 Public "Continue with Demo"

The current public button is not a shared demo login. BrainMVB main implements
this sequence:

1. The browser calls `POST /api/auth/demo-fresh`.
2. BrainMVB creates a new local user with an address shaped like
   `demo-fresh-<random>@brain.fi` and starts an app session.
3. On the first Brain request, `createDemoSession` calls
   `provisionDemoTenant`.
4. `provisionDemoTenant` calls `POST /v1/tenants` with the platform service
   credential and this body shape:

   ```json
   {
     "company_name": "<display name>'s Demo",
     "founder": {
       "email": "<fresh demo email>",
       "display_name": "<display name>"
     },
     "founder_external_ref": "<stable BrainMVB user id>",
     "demo_seed": true
   }
   ```

5. Core creates a new `kind='production'` tenant, bootstrap admin member,
   platform identity link, member session, and BFF service agent. A
   `demo_seed:true` request is database-hash-chain-only and is not published by
   the onchain anchor worker.
6. Core invokes `seedBrainSaasDemo` from
   `services/api/src/demo/brainsaas-seed.ts` directly. This is not a CLI seed
   script and does not use the Golden Path or Northstar seeders.
7. BrainMVB separately invokes `seedTenantDocuments` once, fire and forget.
   It generates five Raw fixture documents and sends them through the real
   `/raw/ingest` and extraction path with the returned BFF agent token.

BrainMVB routes demo users to `DEMO_BRAIN_API_BASE_URL`, whose documented
default is staging. Real users use the production Brain URL. Therefore the
button's fresh-tenant property does not by itself prove that a particular demo
tenant is on true production.

The local 24-hour cleanup removes the BrainMVB user and local rows. It does not
delete the core tenant because no tenant deletion API is used. Core rows remain
durable.

### 1.2 What is fixed and what is regenerated

The Brightline business scenario is a template:

- Company, counterparty, account, invoice, policy, proposal, and source
  definitions use fixed canonical names and values.
- Core generates fresh record identifiers for each new tenant.
- Core derives invoice, obligation, and payment-history dates relative to the
  seeder's current `Date` value.
- BrainMVB generates the Raw fixture documents at seed time with dates relative
  to the current date.
- Seeding runs on tenant creation, not on every login. The 409 adoption path
  explicitly does not run it again because Raw ingestion is not idempotent.

This means each visitor gets separate persisted rows containing the same
fictional scenario, refreshed to the creation date. It is neither one shared
tenant nor a frozen date fixture.

### 1.3 The `braindotfi@gmail.com` Northstar presenter tenant

The presenter identity is not provisioned by "Continue with Demo" and does not
use the Brightline seeder.

The production-gated Northstar workflow:

1. Runs the true-production preflight against `.env.prod`,
   `https://api.brain.fi`, `NODE_ENV=production`, and the primary database.
2. Calls `POST /v1/tenants` with a generated `@brain.invalid` bootstrap founder
   and `demo_seed:false`.
3. Runs `tools/seed-northstar-demo/dist/cli.js` for the newly returned tenant and
   bootstrap actor.
4. Validates the Northstar fixture and uses a separate evaluator tenant.
5. Invites `braindotfi@gmail.com` afterward. The presenter email is therefore a
   joined member, not the tenant-creation identity.

Northstar also uses fixed canonical names and totals with dates generated from
the seed invocation's current `asOf` value. The existing presenter tenant was
seeded once and is not regenerated when the presenter signs in.

### 1.4 Ordinary signup in the current durable deployment

The current app deployment already isolates ordinary signup users at the tenant
boundary. `POST /api/auth/register` creates the BrainMVB account, then the first
Brain-backed request enters `createDurableSession`. That path calls
`POST /v1/tenants` with the stable BrainMVB user id as `founder_external_ref`
and persists one `brain_identities` mapping for that user. It does not use a
shared or default tenant.

The remaining gap is seeding. For an ordinary registered email,
`createDurableSession` omits `demo_seed`, so core does not run
`seedBrainSaasDemo`. BrainMVB also skips `seedTenantDocuments`, leaving the new
tenant empty. Demo identities take the same durable creation path with
`demo_seed:true`, then receive both the core Brightline seed and generated Raw
fixtures. The proposed signup work should converge these existing branches by
changing the ordinary-signup decision, not introduce another provisioning
path.

## 2. Proposed feature boundary

The feature gives each eligible self-serve user:

1. One newly created, isolated Brightline-seeded tenant.
2. One `brain_sk_test_` key scoped only to that tenant.
3. Exactly `raw:read` and `raw:write` on that key.
4. No live money, approval, execution, policy-signing, administration, or
   cross-tenant authority.
5. A reviewed path to a clean production tenant and a separately issued live
   credential.

This feature must not reuse:

- the retired shared `demo@brain.fi` identity,
- an existing visitor's demo tenant,
- the Northstar presenter tenant,
- `tools/seed-northstar-demo`, or
- `tools/seed-golden-path`.

## 3. Proposed signup and provisioning flow

### 3.1 BrainMVB orchestration

After application signup and email ownership verification, BrainMVB should:

1. Resolve the stable BrainMVB user id. Never use email as
   `founder_external_ref`.
2. Check `POST /v1/invites/pending` for the normalized email. A pending invite
   vetoes demo provisioning so an invited user is not bound to another tenant.
3. Persist the existing `pending:create` tombstone before the non-idempotent
   create call.
4. Call `POST /v1/tenants` with the platform credential, the stable external
   reference, and `demo_seed:true`.
5. On `201`, persist the tenant and member mapping before exposing the session.
6. On PR #483's `409 tenant_identity_already_linked`, take
   `details.tenant_id`, exchange the same external reference through
   `POST /v1/sessions`, and require both tenant ids to match. Never create or
   seed a second tenant in this branch.
7. Require a successful core seed summary and ready state before issuing or
   showing a Raw key.
8. Run the existing generated-document seed only once if the product still
   needs the upload and extraction walkthrough in addition to the core
   Brightline rows.

This reuses the existing post-registration `createDurableSession` path. Tenant
isolation, the stable external reference, the pending-invite veto, and the
durable identity mapping already exist. The implementation gap is to opt an
eligible ordinary signup into `demo_seed:true` and the same one-time Raw fixture
generation used for demo identities.

### 3.2 Provisioning readiness

The current core route creates the tenant and identity transaction first, then
runs `seedBrainSaasDemo` outside that transaction. A seeder failure can therefore
leave an identity linked to an empty or partly seeded tenant. The public signup
flow must not turn that state into a usable API-key account.

Add an explicit, tenant-owned provisioning state:

- `provisioning`: tenant and identity exist, seed is not confirmed complete.
- `ready_demo`: Brightline seed completed and the synthetic-data marker is set.
- `seed_failed`: seeding failed and needs a guarded retry or operator repair.
- `archived`: demo tenant was replaced during graduation.

The Brightline seeder must become retry-safe before automatic recovery is
enabled. Until then, a `seed_failed` tenant fails closed and does not receive a
key. The 409 adoption response must lead to a readiness check, not an assumption
that an earlier seed completed.

### 3.3 Durable classification

`tenant.kind` cannot identify this feature because `demo_seed:true` deliberately
keeps `kind='production'`. `audit_anchor_mode='db_only'` is also not a sufficient
authorization marker because other sandbox tenants use it.

Add a durable server-owned classification, for example:

```text
tenant.data_profile = synthetic_brightline_v1 | customer
tenant.access_stage = demo | production_review | production
```

These fields are written only by trusted provisioning and graduation paths.
They are never accepted from an ordinary key-issuance payload. The initial
self-serve state is `synthetic_brightline_v1` plus `demo`.

## 4. Demo-scoped `brain_sk_` key

### 4.1 Issuance

After the tenant reaches `ready_demo`, BrainMVB calls the existing admin route:

```http
POST /v1/tenants/{tenant_id}/keys
Authorization: Bearer <bootstrap admin member session>
Content-Type: application/json

{
  "name": "Demo Raw API key",
  "environment": "sandbox",
  "scopes": ["raw:read", "raw:write"]
}
```

The response returns a `brain_sk_test_` plaintext once. BrainMVB may show it once
to the authenticated user but must not log it, persist it locally, place it in a
URL, or include it in analytics. Core continues to store only the peppered
SHA-256 digest and key metadata.

Key issuance is a second call after tenant creation. It should not be added to
the already large `POST /v1/tenants` transaction. If issuance fails, the tenant
remains `ready_demo` and the user can retry issuance without creating or
re-seeding a tenant.

### 4.2 Authorization policy

The current `API_KEY_PERMITTED_SCOPES` is a universal allowlist containing only
`ledger:read`, `audit:read`, and `governance:read`. It rejects `raw:read` and
`raw:write` even when `environment='sandbox'`.

Replace the universal issuance decision with a context-aware policy:

```text
synthetic Brightline + demo stage + sandbox key
  permits raw:read and raw:write

all other tenant and key combinations
  retain the existing read-only allowlist
```

The key authenticator must also re-check this tenant state at use time. PR #396
currently applies the per-principal scope cap at issuance only. An issuance-only
check is insufficient for graduation because an old demo key would retain
`raw:write` after tenant state changed. A demo Raw key is valid only while all of
these remain true:

- key environment is `sandbox`,
- key is active and unexpired,
- tenant data profile is synthetic Brightline,
- tenant access stage is `demo`, and
- tenant provisioning state is `ready_demo`.

The existing tenant id on `api_keys` and RLS keep every read and write scoped to
that one tenant. The Raw routes continue to enforce `raw:read` or `raw:write` in
the normal gateway path.

### 4.3 Abuse and retention controls

Demo Raw access should have explicit limits independent of scope:

- per-key and per-tenant request limits,
- byte and document quotas,
- no provider credentials or live source connections,
- no payment, approval, execution, policy-signing, or admin scopes,
- a clear synthetic-data label in API and UI responses,
- an expiration and retention policy for demo keys and demo tenants, and
- audit events for issuance, use, rotation, revocation, quota rejection, and
  expiry.

The existing BrainMVB cleanup does not delete core tenants. A core-owned archive
or expiry workflow is required if the product promises that demo tenants expire.

## 5. Graduation to production Raw access

### 5.1 Do not relabel seeded data as customer data

A Brightline-seeded tenant must not graduate in place while retaining synthetic
Ledger, Raw, proposal, source, and audit rows. Doing so would mix fictional and
real business evidence and make provenance ambiguous.

The recommended graduation operation is a clean replacement:

1. User requests production access.
2. Tenant moves to `production_review`; demo Raw keys stop being issuable.
3. Required checks complete.
4. Core creates a new, unseeded production tenant.
5. The platform transfers or rebinds the verified user through a dedicated,
   audited identity-transition operation. This is necessary because the current
   global platform identity link permits only one tenant.
6. Core revokes every demo key before the new link and production session become
   usable.
7. The old demo tenant becomes `archived` and remains clearly synthetic.
8. A production Raw key is issued separately under the production key policy.

Copying demo Ledger or Raw rows into the production tenant is prohibited. A user
may independently upload real source data after the clean tenant is ready.

### 5.2 Recommended initial gates

Production `raw:write` should use manual approval for the first release. The
minimum evidence should be:

- verified control of the account email,
- verified organization name and business domain, with free or disposable
  email treated as a review signal rather than an automatic rejection,
- accepted production data-processing and acceptable-use terms,
- billing identity or an approved commercial account,
- abuse, rate-limit, and security review with no unresolved flags,
- a named accountable administrator, and
- operator approval recorded with reviewer, reason, and timestamp.

Usage may prioritize or inform review, but must not auto-promote a tenant in the
first release. Synthetic requests are easy to manufacture and do not establish
business legitimacy. A future usage-based path requires a separately approved
risk model, fraud controls, rollback, monitoring, and evidence that false
promotion cannot expose production systems.

## 6. PR #396 impact

PR #396 is already merged. There is no remaining "before #396 merges" release
window.

Its current implementation blocks the requested demo Raw key in two ways:

1. `API_KEY_PERMITTED_SCOPES` excludes `raw:read` and `raw:write` for every API
   key. The check does not distinguish sandbox keys, live keys, seeded tenants,
   or unseeded tenants.
2. API-key routes and gateway authentication are mounted only when
   `BRAIN_API_KEY_AUTH_ENABLED=true` with a configured pepper. Repository
   production examples keep the flag off, while staging deployment enables it.
   Actual environment enablement must be verified before release.

Therefore the feature cannot ship merely by asking for a `brain_sk_test_` prefix.
It needs a reviewed extension to PR #396's API-key scope policy plus a use-time
tenant-state check. Production Raw keys remain out of scope and must continue to
fail closed until the graduation policy is implemented and approved.

### 6.1 Separate production route-enablement decision

The Raw-scope exception and production API-key service enablement are separate
go or no-go decisions:

1. The scope-policy change decides whether an eligible synthetic demo tenant
   may issue and use `raw:read` and `raw:write` on a sandbox key.
2. The deployment decision sets `BRAIN_API_KEY_AUTH_ENABLED=true` in production
   with a production pepper, rate limits, acceptance checks, monitoring, and a
   rollback plan.

Production currently leaves the flag off, so key issuance, listing, rotation,
revocation, and usage routes return `route_not_found` regardless of the scopes a
caller requests. The flag must not be flipped implicitly by merging the scope
exception. Record an explicit approval after the production security review and
staging acceptance suite, because enabling it exposes the existing read-only key
surface as well as the proposed demo Raw surface.

## 7. API and test changes required during implementation

Core:

- Persist provisioning state, data profile, and access stage.
- Make Brightline seeding retry-safe or provide a guarded repair workflow.
- Expose a platform or member-visible readiness response without leaking seed
  internals cross-tenant.
- Extend sandbox API-key issuance only for `ready_demo` synthetic tenants.
- Re-check demo Raw-key eligibility in the authenticator on every request.
- Revoke demo keys atomically during archive or graduation.
- Add the clean-tenant identity transition workflow.
- Update OpenAPI, generated SDK types, contracts, scope docs, errors, and audit
  event documentation.

BrainMVB:

- Add the seeded-demo choice to the authenticated self-serve signup funnel.
- Reuse the pending-invite veto and `pending:create` tombstone.
- Reuse PR #483 conflict adoption and tenant-id reconciliation.
- Persist tenant mapping before requesting the API key.
- Show the plaintext key once without logs or local persistence.
- Show seeding, failed-seed, review, and archived states honestly.
- Keep the direct public demo route isolated from registered-user signup.

Required regression coverage:

- Two users receive different tenant ids, member ids, and key ids.
- Each tenant receives its own Brightline rows with no shared identifiers.
- The same external reference returns 409 and adopts exactly one existing
  tenant without re-seeding.
- Pending invites veto tenant creation and key issuance.
- A partly seeded tenant cannot issue or use a Raw key.
- A demo Raw key can read and write only its own tenant.
- The same key cannot read or write another tenant even with a supplied foreign
  tenant id.
- A live key request containing `raw:write` is rejected.
- A non-demo sandbox tenant cannot obtain the demo Raw scope exception.
- Graduation or archive immediately rejects and revokes the old demo key.
- Seed retries do not duplicate Raw, Ledger, proposal, source, policy, or audit
  records.

## 8. Done and pending checklist

### Done in this specification branch

- [x] Traced the current BrainMVB button from browser route to core tenant call.
- [x] Identified `POST /v1/tenants` with `demo_seed:true` as the durable core
      provisioning endpoint.
- [x] Identified `seedBrainSaasDemo` as the core Brightline seeder.
- [x] Identified the separate generated Raw-document seed in BrainMVB.
- [x] Confirmed which seed values are fixed and which values are regenerated.
- [x] Confirmed the Northstar presenter identity uses a separate production
      workflow, seeder, and invite path.
- [x] Confirmed PR #483's 409 contract is reusable.
- [x] Confirmed PR #396 is merged and currently rejects Raw scopes for all API
      keys.
- [x] Confirmed ordinary signup tenant isolation is already implemented: one
      durable tenant per BrainMVB user. The demo-seeding gap remains because
      ordinary users omit `demo_seed` and skip Raw fixture generation.
- [x] Defined the recommended manual-review graduation boundary.
- [x] Defined that graduation creates a clean tenant rather than relabeling
      synthetic data.

### Pending implementation and decisions

- [ ] Decide whether registered seeded demos target staging or true production.
- [ ] Approve the tenant classification and provisioning-state schema.
- [ ] Decide demo tenant and key TTL, storage quota, and request limits.
- [ ] Decide the identity-transition contract for clean-tenant graduation.
- [ ] Implement retry-safe Brightline provisioning and readiness reporting.
- [ ] Implement the conditional sandbox Raw-key policy and use-time check.
- [ ] Converge ordinary signup with the existing demo provisioning behavior:
      after `POST /api/auth/register`, make the existing `createDurableSession`
      path pass `demo_seed:true`, require the `seedBrainSaasDemo` result, and run
      the same one-time Raw fixture generation. Do not build a second tenant
      creation path.
- [ ] Implement one-time API-key display after the converged seed reaches its
      ready state.
- [ ] Make and record the independent production go or no-go decision for
      `BRAIN_API_KEY_AUTH_ENABLED`, including the production pepper, rate limits,
      acceptance test, monitoring, and rollback readiness. Do not combine this
      operational flag flip with approval of the Raw-scope exception.
- [ ] Implement manual production-access review and audit records.
- [ ] Add all core, BFF, isolation, failure, and graduation regression tests.
- [ ] Update API specifications, SDKs, public docs, and operational runbooks.
- [ ] Verify staging end to end with two users and cross-tenant negative tests.
- [ ] Complete security review before enabling any production Raw-key issuance.
