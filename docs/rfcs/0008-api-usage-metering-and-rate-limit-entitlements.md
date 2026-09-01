# RFC 0008. API usage metering and rate-limit entitlements

- **Status:** Implementation in progress. Phase 1 complete on a feature branch;
  rate tiers and billing foundation pending.
- **Date:** 2026-09-01
- **Affects:** API gateway authentication, API-key rate limiting, usage storage,
  production tenancy, OpenAPI, SDK types, BrainMVB Developers and Billing
  surfaces, and the post-graduation commercial model.
- **Related:** RFC 0007, `docs/contracts/production-tenancy.md`,
  `docs/diligence/vm-production-api-key-auth-enablement-scope.md`, brain-core
  PRs #756 and #757, and BrainMVB PR #218.

## 1. Decision summary

API traffic metering must become a first-class gateway concern. It must not be
derived from the tenant audit feed.

The proposed design has three separate records with deliberately different
purposes:

1. A tenant-scoped request meter records exactly one immutable fact for every
   request attributable to a known API key, including failures and rate-limit
   rejections.
2. Security telemetry records missing, malformed, and unknown credentials
   without guessing a tenant or exposing a submitted secret.
3. The existing audit feed continues to record financially and operationally
   meaningful actions. It may retain `key_id` for attribution, but it is not a
   request counter and is not a billing source.

Rate-limit plans become server-owned entitlements. BrainMVB reads the effective
tier from core and cannot change enforcement through local storage. A trusted
billing or operator path assigns a tenant tier, with an optional key-specific
override that can only make a key more restrictive unless a separately
authorized commercial exception permits otherwise.

Billing remains out of scope for this RFC. This RFC defines the minimum meter
that billing can safely consume later.

## 2. Current state and confirmed accuracy gaps

### 2.1 Core usage is currently an audit-event count

`GET /v1/tenants/{tenantId}/usage` in
`services/api/src/production-tenancy/api-key-routes.ts` queries
`audit_events` where `key_id IS NOT NULL`, groups by key, and returns
`total_events`. It does not count a dedicated request record.

The authentication plugin in `shared/src/auth/middleware.ts` emits a fallback
`http.request` audit event only when all of these are true:

- a valid API key authenticated the request,
- the final status is from 200 through 399, and
- no other key-attributed audit event was emitted during the request.

Consequences:

- authenticated 4xx and 5xx responses are absent,
- invalid-key attempts are absent,
- per-key rate-limit rejections are absent because the authenticator throws
  before `request.apiKeyId` and the principal are attached,
- one request can be represented by a domain audit event instead of an HTTP
  request event,
- a request that emits multiple domain audit events can count more than once,
  and
- the result has no reliable HTTP method, route, required scope, outcome, or
  billing classification.

`last_used_at` is intentionally coalesced and display-only. It cannot be used
as a counter or reconciliation source.

### 2.2 BrainMVB's two usage views measure different things

BrainMVB has two data paths:

- `/api/developers/key-usage` proxies core's trailing 30-day per-key audit
  count.
- `/api/developers/usage` reads up to five pages of 200 general tenant audit
  events and aggregates them by audit `action` and `layer`.

The second path powers “Requests This Month” and “Requests by Method.” It
includes member, seeding, agent, policy, and other non-key activity. Its
“method” is an audit action rather than an HTTP method. The 1,000-event cap can
also truncate an active tenant before the requested window is complete.

Environment is inferred from BrainMVB tenancy mode rather than the key that
made the request. The two views are therefore neither equivalent nor suitable
for billing.

### 2.3 Rate limits and the displayed plan are disconnected

Core currently has two relevant controls:

- a Fastify-wide IP-oriented limit of 300 requests per minute, and
- one Redis sliding-window policy for every valid API key, configured by
  `BRAIN_API_KEY_RATE_LIMIT` and `BRAIN_API_KEY_RATE_WINDOW_SECONDS`, with
  defaults of 600 requests per 60 seconds.

The key limiter has no tenant or key tier. Its Redis member identifier uses a
process-local sequence, which should be made globally unique before relying on
the count across multiple replicas. It also deliberately allows a request when
the Redis count cannot be read.

BrainMVB's selected billing plan is stored only in
`client/src/lib/planStore.ts`. The displayed Starter, Standard, Scale, and
Enterprise limits do not alter core. The displayed burst values have no
matching backend concept. A claimed tier above 300 requests per minute can
also be masked by the earlier global IP limit.

## 3. Goals and non-goals

### 3.1 Goals

- Count each attributable API request once, independent of domain audit
  activity.
- Record successful responses, authenticated failures, scope failures,
  server failures, and rate-limit rejections.
- Capture invalid authentication attempts safely without assigning unknown
  traffic to a tenant.
- Attribute requests by tenant, key, environment, scope, HTTP method, and
  normalized route.
- Enforce a server-owned rate tier by tenant and key.
- Make BrainMVB display the same core-owned request facts and effective tier
  that enforcement uses.
- Preserve enough immutable context to support a later, versioned billing
  policy and period close.
- Provide reconciliation and completeness evidence before any usage is
  invoiced.

### 3.2 Non-goals

- Charging a card, issuing an invoice, tax calculation, credits, refunds, or
  revenue recognition.
- Pricing model selection.
- Charging sandbox Brightline demo tenants.
- Inferring a tenant from an invalid key prefix, last four characters, IP
  address, or email.
- Replacing the audit log or turning every HTTP request into a user-visible,
  Merkle-anchored audit event.
- Backfilling precise historical request usage from audit rows. The historical
  data does not contain enough information to do that honestly.

## 4. Request metering model

### 4.1 Gateway lifecycle

Metering belongs in shared gateway hooks, not in every route handler.

1. The request-id plugin assigns the stable request identifier.
2. The auth hook classifies the presented credential.
3. Once a key is cryptographically matched, the hook attaches tenant, key,
   key environment, and entitlement context before rate-limit enforcement.
4. The dynamic key and tenant limiters make their decisions.
5. Route authorization supplies the declared required scope and stable route
   identity.
6. A response hook finalizes exactly one meter record with the final status and
   outcome.

The current authenticator performs the rate-limit check internally and throws
before request context is attached. It should instead return a matched key
context to the auth plugin, which then performs and records the rate decision.
Secret verification remains inside the authenticator.

The finalization hook must run for handler success, handler errors, scope
rejections, and known-key auth rejections. A unique request id makes retries of
the meter write idempotent.

### 4.2 Proposed tenant-scoped record

Add an append-only table owned by the API service, for example
`api_request_meter_events`. It should enable and force tenant RLS and prohibit
updates by runtime roles.

Minimum fields:

| Field                                                                   | Purpose                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `id` and `request_id`                                                   | Stable event identity and exactly-once constraint                                                             |
| `tenant_id` and `key_id`                                                | Tenant and credential attribution                                                                             |
| `occurred_at`                                                           | UTC usage period assignment                                                                                   |
| `environment`                                                           | Sandbox or live, copied from the key at request time                                                          |
| `access_stage`                                                          | Demo, production review, or production snapshot                                                               |
| `method`                                                                | Actual HTTP method                                                                                            |
| `route_template`                                                        | Low-cardinality Fastify route, never a raw URL                                                                |
| `operation_id`                                                          | Stable API operation name independent of route renames                                                        |
| `required_scope`                                                        | Scope that authorized or rejected this operation                                                              |
| `status_code`                                                           | Final HTTP status                                                                                             |
| `outcome`                                                               | Normalized result such as success, client error, server error, scope rejected, auth rejected, or rate limited |
| `effective_tier_id` and `entitlement_version`                           | Policy that governed the request                                                                              |
| `rate_limit_count`, `rate_limit_value`, and `rate_limit_window_seconds` | Reproducible limiter decision when applicable                                                                 |
| `metering_policy_version` and `billable_units`                          | Immutable billing classification, initially zero outside an approved billing policy                           |
| `created_at`                                                            | Persistence timestamp                                                                                         |

Recommended indexes cover tenant and time, tenant plus key and time, and tenant
plus scope plus operation and time. `request_id` must be unique.

The record should not contain the plaintext key, authorization header, request
body, query values, or raw path parameters.

### 4.3 Durability and failure policy

Audit emission currently warns and continues when usage audit persistence
fails. That is acceptable for a convenience dashboard, but not for billing.

Before billing starts, the meter needs one of these reviewed durability modes:

1. Await an idempotent Postgres append before sending the response.
2. Commit to a durable local or external outbox before sending, then write the
   meter asynchronously.

The first option is simpler for the initial request volumes. Production
billable traffic should fail closed with a 503 if its meter cannot be durably
accepted. Sandbox traffic may fail open only if the loss is surfaced as a
critical completeness metric and is never billed.

Direct Redis publication without a durable outbox is not sufficient for a
billing source. Domain audit emission remains independent so a meter outage
does not create duplicate financial audit events.

### 4.4 Outcome and billing are separate decisions

The meter records attempts comprehensively. Recording an attempt does not make
it billable.

Recommended initial billing defaults, subject to commercial approval:

- successful 2xx and 3xx production requests: one billable request unit,
- authenticated 4xx: recorded, initially zero billable units,
- core 5xx and dependency failures: recorded, zero billable units,
- scope rejection: recorded, zero billable units,
- rate-limit rejection: recorded, zero billable units,
- invalid, revoked, or expired credential: recorded as security or nonbillable
  usage, zero billable units, and
- all sandbox or `access_stage=demo` traffic: zero billable units.

If the commercial policy later charges selected 4xx responses or data volume,
that must be a new `metering_policy_version`, not a reinterpretation of closed
historical periods.

## 5. Authentication failures and rate-limit rejections

### 5.1 Attributable failures

Once the submitted secret matches a stored digest, core can safely identify
the key even when it is revoked, expired, or no longer eligible after tenant
graduation. These attempts can create a tenant-scoped, nonbillable meter row
with the precise rejection reason.

A valid key that lacks the route scope is also attributable. It should record
the route, required scope, 403 status, and `scope_rejected` outcome.

A per-key or per-tenant rate-limit rejection happens after the key match. It
must record the known key, tenant, effective tier, observed count, limit, and
429 status before returning the standard error.

### 5.2 Unattributable failures

Missing bearer headers, malformed keys, and secrets that match no stored
digest cannot be charged or shown against a tenant. Prefix and last-four
collisions are not proof of ownership.

Record these in a separate operational security stream or time-bucketed metric
with:

- request id and timestamp,
- normalized route and method,
- rejection category,
- an HMAC fingerprint made with a separate, rotatable telemetry secret when
  repeat-attempt correlation is needed, and
- a privacy-reviewed, short retention period.

Do not store the plaintext credential, the API-key pepper digest, or a raw IP
address in usage tables. If IP abuse controls need correlation, use the
existing trusted proxy boundary and a separately keyed, rotating IP hash.

Unknown attempts may appear in an operator security dashboard. They must not
appear in tenant billing totals.

### 5.3 Interaction with the global limiter

Keep a coarse IP or edge limiter for denial-of-service protection, but treat it
as separate from commercial entitlements. Its rejection occurs before key
identity may be known and therefore belongs to edge security metrics.

The global ceiling must be configurable and high enough not to mask any sold
key tier. Otherwise a tenant shown a 3,000 request-per-minute tier can still be
stopped at 300 requests per minute by the unrelated IP control.

## 6. Scope and route attribution

### 6.1 Declarative route contract

Do not infer scope from a URL prefix and do not attribute every scope granted
to the key. A multi-scope key used on `/ledger/accounts` consumed
`ledger:read`, not every scope it holds.

Extend Fastify route configuration with an API-metering contract containing:

- stable `operationId`, aligned with OpenAPI,
- required scope or explicitly declared alternative scopes,
- metered or explicitly unmetered classification, and
- product family such as ledger, raw, audit, or governance.

The auth and metering context records the scope that actually satisfied the
route. Scope failure records the missing required scope.

Add a structural test that enumerates every route reachable by a tenant API
key. Each must declare exactly one metering contract or a reviewed unmetered
reason. OpenAPI drift tests should ensure the runtime operation id and scope
match the public contract.

### 6.2 Aggregation dimensions

The usage API should support server-side aggregation by:

- key,
- required scope,
- product family,
- operation id and route template,
- method,
- outcome and status class,
- environment, and
- UTC day or hour.

Raw URL paths and query strings must never become group keys because they leak
identifiers and create unbounded cardinality.

## 7. Server-owned rate-limit tiers

### 7.1 Data ownership

Add a versioned rate-tier catalog and a tenant entitlement, for example:

- `api_rate_limit_tiers`: immutable tier revision, window, per-key limit,
  tenant aggregate limit, optional burst policy, and display name.
- `tenant_api_entitlements`: tenant, environment, tier revision, status,
  effective time, source, and audit attribution.
- `api_key_rate_limit_overrides`: optional key-specific restriction or an
  explicitly authorized commercial override.

The trusted demo provisioner assigns the demo sandbox tier. A billing webhook
or guarded operator workflow assigns production tiers. An authenticated tenant
member may request a plan, but must not directly write the effective
entitlement.

All changes require an audit event containing the old and new entitlement,
actor, reason, and effective time.

### 7.2 Enforcement

Replace the one-policy `SlidingWindowRateLimiter` call with a policy resolver
and a limiter that accepts the effective policy for each hit. Enforce both:

- a per-key bucket, preventing one key from exceeding its share, and
- a per-tenant bucket, preventing limit evasion by issuing many keys.

Use a Redis Lua script or equivalent atomic operation for the combined
decision. Redis members need a globally unique request identifier rather than
a process-local sequence so replicas cannot undercount concurrent hits.

Return standard rate-limit headers using the effective policy. The usage API
and BrainMVB must read the same tier revision rather than copying numeric plan
constants.

The current fail-open Redis behavior needs an explicit launch decision. A
contractual tier cannot silently disappear during a Redis fault. The preferred
production posture is a bounded local emergency limiter plus a prominent
degraded signal, or fail closed if the commercial availability policy accepts
that tradeoff. This choice is a go/no-go item for tier launch.

### 7.3 BrainMVB changes

Remove `planStore` as the source for effective limits. BrainMVB should:

- read effective tier, limits, and entitlement status from core,
- show a plan selection as a request or checkout flow until billing confirms
  the server entitlement,
- never claim a tier change before the server returns the new revision,
- display rate-limit state separately from billing price, and
- invalidate tier and usage queries after a confirmed entitlement change.

Until a billing backend exists, the plan control should be read-only or clearly
labeled as a request. A local-storage selection must not look enforceable.

## 8. Usage API and BrainMVB contract

Evolve the current endpoint additively or introduce a versioned replacement.
The response should expose:

- exact UTC `period_start` and `period_end`,
- `total_requests`, `authenticated_requests`, `rejected_requests`, and
  `billable_units`,
- breakdowns by method, key, scope, route, and outcome,
- effective tier and entitlement revision,
- completeness state and last aggregation timestamp, and
- whether raw rows or a finalized billing-period rollup produced the result.

“Requests This Month” must mean the current UTC calendar month, not a trailing
30-day count. “Requests by Method” must contain actual GET, POST, PUT, PATCH,
and DELETE values. Add separate scope and endpoint views rather than relabeling
audit actions.

BrainMVB should retire `/api/developers/usage` aggregation over `listAuditEvents`
and make both summary and per-key panels consume the core meter endpoint. The
general audit feed remains available under Audit Log only.

For scale, begin with indexed raw queries at current volume, then add hourly or
daily rollups with a reconciliation job. Rollups must be reproducible from the
immutable meter rows and identify their covered high-water mark.

## 9. Minimum billing foundation versus deferrable analytics

### 9.1 Required before metered post-graduation billing

- One idempotent, durable meter record per attributable request.
- Final status and normalized outcome, including rejected requests.
- Tenant, key, environment, access-stage snapshot, scope, operation, method,
  and timestamp attribution.
- Server-owned entitlement revision and enforced key plus tenant limits.
- Versioned billable-unit policy with demo and sandbox traffic excluded.
- Calendar billing-period boundaries in UTC.
- Period close that freezes totals, records source high-water marks, and does
  not reinterpret history after a policy change.
- Reconciliation against gateway request totals, limiter decisions, and meter
  persistence failures.
- Customer-visible totals that come from the same records as billing.
- Adjustment and dispute records rather than mutation of closed usage.
- Retention, access control, RLS, export, deletion, and privacy decisions.
- A shadow period with zero invoices and an explicit accuracy acceptance gate.

This is the minimum for request-count billing. Charging by Raw bytes, stored
data, compute time, agent work, or model tokens needs additional dedicated
meters and is not implied by request counts.

### 9.2 Deferrable

- Latency percentiles and performance dashboards.
- Request and response byte analytics unless pricing uses bytes.
- SDK version, user agent, geography, and referrer analytics.
- Real-time spend alerts and forecasts.
- A tenant-admin UI for distributing a tenant allowance among keys.
- Custom enterprise tier editing in BrainMVB.
- Long-term raw-event retention after verified rollups and closed periods.
- Payment processor, invoice presentation, tax, credits, and collections.

## 10. Sequencing and effort

### Phase 0. Contract decisions, 1 to 2 engineer-days

- Approve billable outcome defaults.
- Choose sliding-window versus token-bucket burst semantics.
- Choose Redis degradation behavior.
- Confirm UTC billing periods and retention.
- Confirm whether the first commercial meter prices requests only.

### Phase 1. Dedicated request meter, 5 to 7 engineer-days

- Add append-only RLS storage and idempotency.
- Refactor auth context so known failures and rate rejections are attributable.
- Add one finalizer for all outcomes.
- Add separate unknown-auth security telemetry.
- Run in nonbilling shadow mode.

This is foundational.

### Phase 2. Route and scope contract, 3 to 5 engineer-days

- Add runtime route metadata.
- Cover all API-key-accessible ledger, raw, audit, and governance routes.
- Add structural OpenAPI drift guards.
- Add scope, route, method, and outcome aggregates.

This is foundational for explainable billing and accurate product usage.

### Phase 3. Entitlements and dynamic enforcement, 5 to 7 engineer-days

- Add tier catalog, tenant entitlement, and restricted key overrides.
- Make Redis decisions policy-driven and replica-safe.
- Enforce both key and tenant buckets.
- Return accurate headers and define degraded behavior.

This is foundational before selling differentiated tiers.

### Phase 4. Usage API and BrainMVB convergence, 4 to 6 engineer-days

- Replace audit-feed aggregation.
- Render calendar-month, method, scope, route, outcome, and key data.
- Replace local-storage tier display with the core entitlement.
- Make plan selection honest until billing confirms it.

The customer-visible usage view is foundational before billing. Advanced
charts are deferrable.

### Phase 5. Billing-readiness hardening, 3 to 5 engineer-days

- Add rollup reconciliation, period close, completeness alarms, adjustments,
  and export.
- Run a zero-charge shadow period and compare gateway, Redis, raw meter, and
  rollup totals.
- Approve a production billing start timestamp. Do not back-bill earlier
  traffic.

Estimated total is 20 to 30 engineer-days for one engineer, excluding payment
processing and commercial policy work. Two engineers can overlap BrainMVB and
core work after the event and entitlement contracts are approved, but the
metering foundation and route contract should land first.

## 11. Validation required by an implementation

- Successful 2xx and 3xx requests create exactly one meter row even when zero,
  one, or multiple domain audit events are emitted.
- Authenticated 4xx and 5xx requests create exactly one nonduplicate row.
- Scope rejection records the known key and required scope.
- Known revoked, expired, and ineligible keys record nonbillable rejection
  without granting a principal.
- Unknown keys never receive a tenant or key attribution.
- Rate-limit rejection records the exact effective policy and does not create
  a domain audit-event substitute.
- Concurrent replicas cannot collide or undercount Redis hits.
- Key rotation retains separate key attribution while tenant totals remain
  continuous.
- Demo and sandbox traffic always produce zero billable units.
- Requests by method and route use normalized metadata, never raw URLs.
- General member, seeding, and agent audit activity never changes API request
  totals.
- Usage endpoint totals reconcile to raw meter rows across pagination and
  calendar boundaries.
- BrainMVB displays the server tier and cannot alter it through local storage.
- Meter persistence failure exercises the approved fail policy and emits a
  critical completeness signal.
- Standard typecheck, test, lint, invariants, RLS coverage, OpenAPI, SDK, and
  no-em-dashes checks pass.

## 12. Done and pending checklist

### Done in this scope

- [x] Traced core's successful-only audit fallback and usage query.
- [x] Traced the per-key limiter and the earlier global IP limiter.
- [x] Traced BrainMVB's general-audit aggregation and local plan store.
- [x] Defined safe handling for attributable and unknown auth failures.
- [x] Defined request, scope, route, method, outcome, and tier attribution.
- [x] Separated billing prerequisites from optional analytics.
- [x] Defined sequencing, effort, and validation expectations.
- [x] Added the append-only, tenant-RLS `api_request_meter_events` store.
- [x] Replaced `audit_events` as the tenant usage endpoint's count source.
- [x] Added declarative operation, required-scope, and product-family route metadata.
- [x] Metered successful responses, known-key failures, scope failures, server failures,
      and API-key rate-limit rejections through one gateway finalizer.
- [x] Kept missing, malformed, disabled, and unknown credentials in separate security
      telemetry with no guessed tenant or key attribution.
- [x] Added structural route coverage and OpenAPI operation-id drift tests.

### Pending implementation or decision

- [ ] Approve Phase 0 billing and limiter decisions.
- [x] Implement the dedicated request meter and security telemetry.
- [x] Add route metering metadata and drift guards.
- [ ] Add server-owned entitlements and dynamic Redis enforcement.
- [ ] Replace BrainMVB audit aggregation and local tier claims.
- [ ] Complete a zero-charge shadow and reconciliation period.
- [ ] Approve a future billing-system implementation separately.
