# RFC 0011. RobotMoney self-serve commercial tiers

- **Status:** Implementation in progress. Phase 1 disabled contract foundation
  closed on 2026-09-03. Phase 2 observe-only work has begun, but its minimum
  30-day clock is not active until the reviewed shadow configuration is
  deployed.
  The earlier placeholder catalog remains superseded, and no commercial
  feature or customer-visible behavior is enabled.
- **Date:** 2026-09-03
- **Affects:** RobotMoney catalog, tenant and billing-account entitlements,
  Stripe base subscriptions, x402 API and MCP overage, agent and entity limits,
  money-movement limits, BrainMVB tier surfaces, member authorization,
  cancellation, audit, and operator workflows.
- **Related:** RFC 0007, RFC 0008, RFC 0009, RFC 0010, RFC 0012, and
  `.github/workflows/ops-api-entitlements.yml`.

## 1. Decision summary

RobotMoney has five named tiers: Free, Starter, Growth, Scale, and Enterprise.
This catalog replaces the placeholder catalog previously described by this RFC.

An authenticated tenant admin may view eligible public tiers and request a
self-serve change. Free, Starter, Growth, and Scale are the approved public
catalog. Scale is the highest self-serve tier. Enterprise pricing and
entitlement changes are always operator-only.

The payment components are independent:

- Stripe collects the recurring base price for Starter, Growth, and Scale.
- Free requires no Stripe subscription.
- x402 collects approved API and MCP overage in USDC under RFC 0012.
- Collections-resolved and fraud-stopped outcome add-ons launch through Stripe
  invoicing under RFC 0009.
- RobotMoney directly earns the 0.3 percent money-movement fee and approved
  foreign-exchange spread under RFC 0009.

The browser never writes entitlements directly and never proves payment by
returning from Stripe or presenting an unverified x402 header. Core applies
only an immutable catalog-backed transition after all applicable payment and
eligibility state is verified.

## 2. Approved catalog

### 2.1 Tier chart

The base prices below are USD monthly list prices. USD, EUR, and GBP monthly
and annual price books launch together. Prices exclude tax, which is added at
checkout from the separately approved compliance configuration. The approved
annual discount and localized-price mechanism are defined in RFC 0009.

| Tier       |                              Base price | RobotMoney agents |  Entities | Monthly execution limit | External API and MCP              |
| ---------- | --------------------------------------: | ----------------: | --------: | ----------------------: | --------------------------------- |
| Free       |                                      $0 |                 1 |         1 |                  $5,000 | Not included                      |
| Starter    |                                     $99 |                 2 |         1 |                 $25,000 | Not included                      |
| Growth     |                                    $499 |                 5 |         1 |                $250,000 | Included, quantities below        |
| Scale      |                                  $2,500 |                11 |  Up to 10 |   $2,500,000 per entity | Included, quantities below        |
| Enterprise | Custom, stated range $10,000 to $50,000 |          Contract | Unlimited |                Contract | Volume pricing, contract-specific |

Every tier also advertises 0.3 percent on money moved through agent accounts
plus a foreign-exchange spread. RobotMoney is the fee beneficiary and collector.
RFC 0009 contains the calculation, invoicing, reversal, and approved 0.50
percent spread mechanics.

Collections-resolved and fraud-stopped outcome fees are optional add-ons that
ship at launch and invoice through Stripe. Collections resolved is 10 percent
of qualifying net principal recovered. Fraud stopped is 2 percent of verified
prevented principal, with a $10 minimum and no maximum. RFC 0009 defines the
evidence and reversal rules.

### 2.2 Allowance and overage policy

API and MCP use separate allowance pools. The approved quantities and public
x402 prices are:

| Tier       | Included API units per month | Included MCP units per month | Exact API overage | Exact MCP overage |
| ---------- | ---------------------------: | ---------------------------: | ----------------: | ----------------: |
| Free       |                            0 |                            0 |        $0.01 USDC |        $0.10 USDC |
| Starter    |                            0 |                            0 |        $0.01 USDC |        $0.10 USDC |
| Growth     |                       25,000 |                        2,500 |        $0.01 USDC |        $0.10 USDC |
| Scale      |                      250,000 |                       25,000 |        $0.01 USDC |        $0.10 USDC |
| Enterprise |                     Contract |                     Contract |          Contract |          Contract |

One API unit is one successfully fulfilled API operation under RFC 0008. One
MCP unit is one successfully fulfilled tool call. Expensive or variable-cost
operations are excluded from the public price list until an immutable
operation-specific price is approved. They must not silently consume multiple
units.

Free and Starter have no included external access, but may buy standalone API
or MCP calls through x402 without a subscription. Tenant-scoped resources still
require tenant authorization; an anonymous payer wallet need not be linked to
that tenant or billing account. RFC 0012 proposes a distinct pay-per-call
credential for this path.

The allowance quantities, $0.01 API price, $0.10 MCP price, and one-operation
unit definitions are approved. Enterprise remains contract-specific and
operator-only.

## 3. Current implementation and replacement boundary

Phase 1 replaces the earlier narrow placeholder contract with the accepted
RobotMoney catalog and independent commercial dimensions. Migration 0029 now
defines immutable tier and localized-price revisions, fee and x402 price
policies, entity and configured-agent projections, commercial entitlements,
allowance reservations, execution limits, Stripe projections, provider
commands, x402 evidence, and responsibility assignments.

This is a disabled foundation:

- all environment feature flags default false,
- all database activation gates are `disabled`,
- every catalog and price row has self-serve disabled,
- the application role has no commercial table mutation grant,
- the billing routes are not registered while the catalog flag is false,
- no tenant, entity, agent, entitlement, billing account, provider event, or
  payment operation is created by the migration, and
- no Stripe, Coinbase CDP, wallet, or Base credential is defined or consumed.

The pre-existing unpaid request-rate mutation implementation remains dormant
behind those fences. It is not proof of a purchased tier and is not an
activation path. Later phases replace its narrow transition logic before any
catalog revision becomes self-serve.

## 4. Catalog and entitlement model

### 4.1 Separate commercial tier from rate-limit tier

A RobotMoney tier is a bundle of independent entitlements. It is not another
name for an API request-rate tier.

The immutable catalog and related contracts include:

- stable public tier id, revision, display name, and description,
- brand and customer-facing legal copy version,
- base price, currency, interval, and Stripe Price mapping when applicable,
- maximum RobotMoney agents,
- maximum entities or unlimited marker,
- money-execution limit amount, currency, period, and per-entity or aggregate
  scope,
- external API access flag,
- external MCP access flag,
- separate API and MCP included allowance policies,
- RFC 0008 request-rate and burst entitlement mapping,
- RFC 0012 x402 overage policy and operation-price version,
- optional Collections and fraud outcome-add-on eligibility and approved price
  policy,
- applicable fee-disclosure version,
- public, self-serve, and operator-only flags,
- effective and retirement timestamps, and
- permitted upgrade and downgrade targets.

The commercial entitlement projection must expose each dimension and its
source revision. A single `target_rate_tier_id` is not enough.

### 4.2 External access versus product-internal traffic

No API or MCP access on Free and Starter means no customer-facing external API
key or external MCP entitlement. It must not disable BrainMVB's authenticated
session calls to Core or other internal service traffic required to operate the
product.

The later access contract must distinguish:

- RobotMoney application access through member sessions,
- external commercial API access through tenant API keys,
- external MCP access through supported machine credentials, and
- internal service-to-service calls.

Do not model no external access as a global request-rate limit of zero.

### 4.3 Public and Enterprise overage

Growth and Scale receive separate included API and MCP allowances. After the
applicable allowance is exhausted, eligible operations require x402 exact
payment under RFC 0012.

Free and Starter may buy standalone x402 calls despite having no included API
or MCP allowance. They do not gain broad external access or a reusable included
entitlement from one payment. Each successful payment authorizes exactly one
quoted operation.

Enterprise uses contract-specific volume pricing. Do not assume that Enterprise
uses the same public x402 price, allowance period, settlement scheme, or wallet
flow. Its catalog revision may reference a negotiated policy but remains
operator-only.

## 5. RobotMoney agent dimension

One billable agent is one configured and active RobotMoney agent instance. An
idle active agent still counts. Draft, deleted, system-owned bootstrap, demo,
and capacity-paused instances do not count. A logical agent configured as two
active instances counts twice.

The limit is tenant-wide across all entities. An agent belongs to exactly one
entity at a time. Moving an agent between entities does not change the tenant
count, but must be audited and cannot cross authorization boundaries without a
server-side transition.

Approved ownership: Core owns the canonical mapping between the billable
RobotMoney agent instance and the internal principals, runtime, entity, and
lifecycle state it authorizes. RobotMoney surfaces read this projection and do
not maintain a separate billable count.

The authoritative create, activate, resume, clone, and import paths fail closed
when the limit is reached. Pausing an agent preserves configuration and history
but prevents new work, money actions, API actions, and scheduled execution.
Client-only counting is never sufficient.

The exclusions, instance-counting rule, Core ownership assignment, and business
definition that active configured instances count even while idle are
approved.

## 6. RobotMoney entity dimension

One Brain tenant can contain multiple RobotMoney entities. Scale permits up to
ten; Enterprise is contractually unlimited. Free, Starter, and Growth each
permit one.

An entity is a first-class server-owned scope inside a tenant. This decision
requires a later architecture and schema RFC because tenant row-level security
alone is no longer the complete business-data boundary. At minimum, entity
scope must be explicit and enforced across Ledger, Policy, execution, Raw,
sources, approvals, audit, keys, agents, and request metering.

Approved mechanics:

- Every entity has an immutable id, tenant id, display metadata, lifecycle
  state, and effective commercial-cap revision.
- Every entity-owned record carries an entity id or is explicitly classified
  as tenant-global.
- Member and machine authorization names permitted entity ids. Missing entity
  context fails closed on entity-owned routes.
- Entity creation, activation, resume, import, and transfer enforce the tier
  limit transactionally.
- A capacity-paused entity remains readable to authorized admins but cannot
  create work, approve or execute money movement, activate agents, or consume
  included API and MCP allowance.
- Cross-entity queries require an explicit tenant-admin capability and produce
  per-entity attribution rather than silently merging records.

Core remains the authority for entity scoping. RobotMoney owns the customer
experience but cannot enforce the limit only in the browser.

## 7. Monthly money-execution dimension

The execution limit is independent of API request allowance and request-rate
limits. It belongs on the deterministic money-movement path and must fail
closed before a payment exceeds the applicable cap.

The chart defines a hard monthly capacity, not an overage price. A request
beyond the cap does not incur x402 or a 0.3 percent fee and proceed. It is
rejected unless an already-paid tier upgrade provides capacity.

Approved execution-limit mechanics:

- Apply every public tier's stated limit independently to each active entity.
  This is explicit for Scale and immaterial for one-entity lower tiers.
- Use calendar months in UTC.
- Count gross outgoing principal for external ACH, wire, card, stablecoin, and
  other money rails when execution reserves the amount. Exclude internal book
  transfers, rejected attempts, partner fees, RobotMoney fees, and FX spread.
- Maintain `settled`, `reserved`, and `reversed` USD-equivalent amounts. The
  admission check uses settled plus active reservations so concurrent actions
  cannot overshoot the cap.
- Convert non-USD principal using the executable partner reference rate locked
  when the movement is approved. Record source amount, rate, USD equivalent,
  and rate timestamp. The commercial FX spread does not increase cap usage.
- Release failed or expired reservations. Subtract a settled movement only
  after an authoritative full or partial reversal becomes terminal.
- An upgrade raises the remaining capacity immediately without resetting used
  amount. A downgrade never rewrites used amount; new execution remains blocked
  until the lower cap has room or a later period begins.
- Operator adjustments are compensating records with reason, actor, and source
  evidence. They never mutate settled movement facts.

These aggregation, currency, reservation, and reversal rules are approved.

Core's execution gate must use a durable counter or reservation derived from
authoritative settlement facts. It must not query a client-maintained total.

## 8. Public catalog and self-serve experience

### 8.1 Read view

Tenant admins should see:

- current RobotMoney tier and immutable revision,
- recurring base price and next renewal date,
- agent use and maximum,
- entity use and maximum,
- monthly execution use and limit with scope clearly labeled,
- external API and MCP availability,
- separate included API and MCP allowances,
- x402 standalone and overage eligibility with published per-operation prices,
- payment, delinquency, hold, and pending-change state,
- available public tiers with exact differences,
- the RobotMoney 0.3 percent and foreign-exchange disclosure, and
- optional Collections and fraud outcome add-ons with current pricing and
  evidence definitions.

Unknown values display as not yet available, not zero and not unlimited.

### 8.2 Upgrade flow

The planned public flow is:

1. The admin selects an eligible immutable catalog revision.
2. Core verifies tenant, billing account, membership, hold, and current
   entitlement state.
3. Core returns a short-lived preview of the recurring base-price change and
   each entitlement difference.
4. The admin confirms after recent authentication or an approved step-up.
5. Free applies without Stripe only when no paid entitlement is being granted.
6. Starter, Growth, and Scale use Stripe Checkout or a pending subscription
   update under RFC 0009.
7. Upgrades apply immediately after the prorated charge succeeds. New limits
   become available the same day from verified Stripe state.
8. Core and RobotMoney refresh the server-owned state.

x402 is not used to purchase the recurring tier. Buying one paid API call does
not upgrade the tenant.

### 8.3 Downgrade and cancellation

Approved behavior:

- Downgrades below current agent or entity capacity are allowed. Excess objects
  become capacity-paused and read-only rather than being deleted.
- Downgrading below API or MCP tier eligibility revokes existing external API
  keys and MCP credentials automatically.
- Cancellation preserves current access through the already-paid period, gives
  no refund for unused time, and falls back to Free at period end.
- Already settled x402, outcome, and money-movement charges remain settled
  unless their own dispute or reversal policy applies.

Approved downgrade mechanics:

- Apply a paid downgrade immediately after Stripe confirms the prorated credit.
  The credit remains on the customer balance rather than becoming a cash
  refund.
- Require the admin to select which agents and entities remain active during
  the downgrade preview. If the effective transition arrives without a valid
  selection, keep the earliest-created eligible objects active and pause the
  newest excess objects deterministically.
- A capacity-paused object stops new work and money movement but remains
  readable to authorized admins. Resuming it requires available capacity.
- Revoke broad included-access credentials before activating the lower tier.
  A customer may then create a distinct pay-per-call credential under RFC 0012;
  it receives no allowance and cannot restore broad tier access.
- Preserve already consumed API, MCP, and execution amounts for the calendar
  month. Tier cycling never resets them.

The immediate downgrade timing, deterministic fallback ordering, and separate
pay-per-call credential are approved.

## 9. Authorization, audit, and consistency

Tier mutations require:

- authenticated member session,
- active tenant membership and `admin` role,
- recent authentication or approved step-up,
- CSRF protection on the RobotMoney or BrainMVB backend-for-frontend,
- idempotency key,
- expected catalog, entitlement, and subscription versions,
- no applicable billing, fraud, compliance, or legal hold, and
- explicit confirmation of the previewed price and effective time.

Approved authentication policy: require authentication within the prior 15
minutes for any paid change, cancellation, promo redemption, or pay-per-call
credential issuance. Require an enrolled MFA challenge for Scale changes when
the tenant has an MFA method. Public catalog facts may be viewed by any signed-in
member; billing account, invoices, payment state, and mutations remain admin-only.

API keys, agents, Slack, Teams, email, and WhatsApp surfaces cannot change the
commercial tier in the initial release.

Every attempt records the session-derived actor, tenant, billing account,
requested revision, before and proposed state, preview, provider request ids,
idempotency key, result, rejection reason, final verified state, and linked
entitlement-change evidence. Do not store card details, Stripe client secrets,
wallet signing material, or full x402 payment headers.

Stripe is authoritative for recurring subscription payment. Brain is
authoritative for enforced Core entitlements. RobotMoney is authoritative only
for product concepts expressly assigned to its service boundary. A nightly and
period-close reconciler compares each projection and blocks further self-serve
changes on unresolved divergence.

## 10. Abuse and financial safeguards

- Rate limit preview and mutation endpoints.
- Permit one active tier-change workflow per billing account.
- Use provider idempotency and local compare-and-set versions.
- Do not reset included usage or monthly execution through tier cycling.
- Do not activate paid limits before verified recurring payment.
- Do not let x402 payment bypass a compliance hold, tenant authorization, or
  money-execution cap. Standalone x402 access is an approved product path, not
  a tier-entitlement bypass.
- Keep Scale as the maximum public tier.
- Apply velocity and linked-account checks only through approved identifiers.
- Offer spend alerts and hard caps only after their semantics are defined.
- Preserve operator emergency suspension that self-service cannot undo.

Safeguards must not use protected characteristics or undisclosed consumer
credit scoring. Risk signals and denial handling follow the approved RFC 0010
policy.

## 11. What remains operator-only

The protected operator control plane remains the only path for:

- Enterprise pricing and negotiated volume policies,
- limits above the public Scale catalog,
- permissive key or entitlement overrides,
- fraud, sanctions, compliance, or legal holds,
- manual graduation review and risk overrides,
- credits and goodwill outside published self-serve promo and trial rules,
- exceptional refunds outside the approved outcome and service-failure policy,
- corrections to closed usage, execution, outcome, or fee periods,
- outcome disputes and exceptional reversals,
- grandfathered contract migration,
- currency or billing-interval exceptions,
- emergency suspension or restoration,
- forced cancellation, and
- repair of provider and Brain projection divergence.

RobotMoney and BrainMVB expose no UI or public route for these actions. The
existing `ops-api-entitlements.yml` workflow should narrow to applicable
exceptional rate-entitlement cases. It is not a general RobotMoney catalog
editor.

## 12. Planned API boundary

Names are illustrative and require later OpenAPI review:

- `GET /v1/billing/catalog`
- `GET /v1/tenants/{tenantId}/commercial-entitlement`
- `GET /v1/tenants/{tenantId}/entities`
- `POST /v1/tenants/{tenantId}/entities`
- `POST /v1/tenants/{tenantId}/entities/{entityId}/pause`
- `POST /v1/tenants/{tenantId}/entities/{entityId}/resume`
- `GET /v1/tenants/{tenantId}/billing`
- `POST /v1/tenants/{tenantId}/billing/checkout-session`
- `POST /v1/tenants/{tenantId}/billing/change-preview`
- `POST /v1/tenants/{tenantId}/billing/change-confirm`
- `POST /v1/tenants/{tenantId}/billing/cancel`
- `POST /v1/tenants/{tenantId}/billing/cancel-reversal`
- `POST /v1/tenants/{tenantId}/billing/portal-session`

The public request submits a catalog revision and expected versions. It never
submits arbitrary prices, limits, Stripe Price ids, x402 recipients, or
entitlement values.

Entity and agent mutations require a later architecture and schema RFC before
their exact public contract is approved.

## 13. Approved implementation decisions

- Growth includes 25,000 API and 2,500 MCP units per calendar month. Scale
  includes 250,000 API and 25,000 MCP units.
- Public x402 prices are $0.01 USDC per API operation and $0.10 USDC per MCP
  tool call. Expensive operations require explicit prices before publication.
- Draft, deleted, system bootstrap, demo, and capacity-paused agents do not
  consume the configured-active limit. Core owns the canonical count.
- Entity scoping follows the server-side mechanics in section 6 and receives a
  separate architecture and schema RFC before implementation.
- Execution limits follow the per-entity UTC calendar-month, USD-equivalent,
  reservation, and reversal policy in section 7.
- Paid downgrades apply immediately with a Stripe customer-balance credit.
- Admins select objects to pause; earliest-created objects remain active as the
  deterministic fallback when no valid selection exists.
- Lower-tier included-access credentials are revoked, after which admins may
  issue a separate no-allowance pay-per-call credential.
- Paid mutations require authentication within 15 minutes, with MFA for Scale
  changes when a method is enrolled.
- Signed-in members may view public catalog and current tier facts. Billing
  account details and mutations remain admin-only.

### 13.1 BrainMVB to RobotMoney migration

Current ownership:

- Damon is the single accountable owner for Product, BrainMVB client surface,
  Core, Platform, Finance Controller, Treasury, Security, and Billing
  Engineering responsibilities.
- Those names are stable responsibility labels, not separate current teams or
  role-holders.
- Every approval and action records the responsibility label and authenticated
  actor separately. A future assignment registry can delegate labels to
  distinct people without changing schemas, workflows, catalog contracts, or
  historical attribution.
- The initial assignment for every label uses authenticated actor
  `user_01M0NTPB2292Z4BF5BHVEM41C6`.

Approved sequence:

1. Add RobotMoney catalog identifiers and copy behind a disabled client feature
   flag. Keep API paths and stable ids unchanged.
2. Launch RobotMoney surfaces with a 30-day dual-brand notice and both old and
   new entry points using the same authenticated server state.
3. Make RobotMoney the primary entry point, retain redirects and monitored
   compatibility for 90 days, and publish migration guidance.
4. Retire BrainMVB branding only after traffic, OAuth callbacks, webhooks,
   support links, and saved client URLs show no material dependency.

The single-owner model, 30-day notice, and 90-day compatibility period are
approved. This RFC does not itself authorize a domain, API namespace, or OAuth
change; those are later implementation actions under the Platform
responsibility label.

Compliance-owned launch countries, KYB trigger criteria, tax registrations,
merchant entity, and Stripe Tax setup remain Damon's separate track. This RFC
only requires explicit activation gates that consume those approved inputs.

## 14. Coordinated implementation phases

Each phase requires a check-in and the RFC 0008 validation bar before the next
phase begins.

### Phase 1. Contracts and disabled foundations

- Add immutable catalog, localized price-book, fee-policy, entity, agent,
  commercial entitlement, allowance, execution-limit, Stripe projection,
  provider-command, x402 evidence, and responsibility-assignment contracts.
- Define provider ports and OpenAPI feature-gate metadata without provider
  implementations.
- Keep every environment and database activation gate disabled, grant no
  application writer, add no production credential, and enable no
  customer-visible behavior.
- **Status:** Closed on 2026-09-03 after entity-backfill, retention,
  localized-price, responsibility-assignment, migration-order, and Base Sepolia
  wallet review items were resolved.

### Phase 2. Catalog, entity, and entitlement shadow

- Project the accepted immutable RobotMoney catalog revisions into server-owned
  entitlement decisions.
- Add entity and configured-active-agent dimensions behind disabled feature
  flags.
- Compute API, MCP, agent, entity, and execution-limit decisions in shadow while
  existing behavior remains authoritative.
- Run execution-limit shadow for at least 30 days and reconcile daily against
  settled movement evidence.
- Record every evaluation as counterfactual evidence with
  `enforcement_applied=false`. The schema prevents an observation from claiming
  enforcement occurred.
- Do not infer a commercial tier from the legacy API rate-limit tier. Record
  `catalog_revision_unresolved` until an explicit commercial entitlement exists.
- **Status:** Begun on 2026-09-03. Observe-only contracts, evaluation logic,
  evidence-source projection, and the minimum-30-day review fence are
  implemented. Production observation remains disabled pending this check-in.

### Phase 3. Read UI and self-serve lifecycle sandbox

- Build the RobotMoney catalog, comparison, usage, and change-preview surfaces.
- Exercise upgrades, immediate downgrades, capacity pausing, key revocation,
  cancellation, Free fallback, promo codes, and trials against Stripe test mode.
- Do not grant a live paid entitlement from a sandbox result.

### Phase 4. Stripe projection shadow and internal canary

- Follow RFC 0009's contract, subscription-shadow, internal-canary, and
  fee-shadow checkpoints.
- Require two accelerated billing cycles plus a 30-day fee shadow.
- Admit only RobotMoney-owned tenants to the first live-money canary.

### Phase 5. Graduation and KYB integration points

- Preserve RFC 0010's fresh-production-tenant rule and existing graduation
  lineage.
- Add a pluggable compliance-decision input at the money-holding and
  money-movement gates without encoding launch countries, KYB criteria, tax
  registrations, merchant entity, or Stripe Tax policy in Core.
- Run the integration in observe-only mode until Damon's separate compliance
  configuration is approved, then rehearse approved, denied, pending, timeout,
  and manual-review responses in staging.

### Phase 6. x402 Base Sepolia sandbox and settlement shadow

- Exercise exact payments, automatic refunds, allowance reservations,
  pay-per-call credentials, and MCP compatibility on Base Sepolia.
- Run the approved 14-day settlement shadow with no customer payment or
  production 402 response.

### Phase 7. Internal Base mainnet canary

- Admit only RobotMoney-owned callers and the approved operation allowlist.
- Retain the $0.10 per-call and $100 daily exposure caps until at least seven
  days and 1,000 successful operations complete with independent
  reconciliation and refund drills.
- Keep Bazaar publication disabled until the canary exits successfully.

### Phase 8. Limited customer cohort

- Enable the full tier lifecycle, Stripe billing, outcome and movement fees,
  x402, and enforcement for an allowlisted customer cohort.
- Reconcile Stripe, Brain facts, Coinbase facilitator receipts, Base receipts,
  entitlements, and customer-visible statements daily.
- Keep rollback and operator repair paths rehearsed.

### Phase 9. RobotMoney general availability and brand migration

- Begin the approved 30-day dual-brand period only after the limited cohort
  meets its exit criteria.
- Make RobotMoney primary, publish eligible paid endpoints in Bazaar, and retain
  the approved 90-day redirect and compatibility window.
- Expand through a separately approved production activation runbook.

Phase 1 authorizes only the reviewed disabled foundation. Every later phase
requires its own check-in. No Stripe, x402, wallet, real-money, or production
activation is authorized until the applicable sandbox or shadow exit is
explicitly reviewed.

## 15. Required validation for a later implementation

- The public catalog returns the exact approved names, prices, and limits.
- Catalog allowances and public x402 prices match the approved revision.
- A non-admin or machine principal cannot change a commercial tier.
- Posting an unpublished revision, price, or limit is rejected.
- Free and Starter receive no included API or MCP access, while an approved
  pay-per-call credential can authorize one x402-paid operation.
- BrainMVB session traffic continues on Free and Starter.
- Agent limits use the approved RobotMoney definition and cannot be bypassed by
  another creation path.
- Entity limits use the approved mapping and preserve isolation.
- Concurrent money movements cannot exceed the monthly execution limit.
- Scale's execution limit is enforced independently for each approved entity.
- Stripe payment changes recurring entitlement exactly once.
- x402 payment changes only the one approved overage operation and never buys a
  tier or money-execution capacity.
- Tier cycling cannot reset allowance or money-execution counters.
- Downgrade and cancellation never delete customer data automatically.
- Existing external credentials follow the approved lower-tier transition.
- Provider divergence blocks mutations and alerts operators.
- All actions have session-derived actor and before and after evidence.
- RobotMoney and BrainMVB expose no enterprise, override, hold, credit, or
  repair controls.
- Standard typecheck, test, lint, invariants, row-level-security, OpenAPI, SDK,
  migration, and no-em-dashes checks pass when implementation begins.

## 16. Done and pending checklist

### Done in this revision

- [x] Replaced placeholder commercial definitions with the RobotMoney chart.
- [x] Separated recurring Stripe payment from x402 usage payments and fee
      invoicing.
- [x] Incorporated the multi-entity tenant and configured-active agent
      decisions.
- [x] Approved allowance, x402 pricing, execution, downgrade, and brand
      migration mechanics.
- [x] Assigned every responsibility label to Damon while preserving later
      delegation through a separate assignment registry.
- [x] Confirmed the 10 percent Collections fee and uncapped 2 percent fraud fee.
- [x] Documented the placeholder replacement boundary and disabled foundation.
- [x] Preserved the operator-only exceptional-action boundary.
- [x] Flagged the RFC 0010 KYB trigger question without changing RFC 0010.
- [x] Added the accepted catalog, entity, configured-agent, commercial
      entitlement, allowance, and execution-limit contracts behind disabled
      gates.

### Pending implementation and activation review

- [x] Closed every commercial and technical decision in section 13.
- [x] Approved and implemented the disabled Phase 1 catalog and entitlement
      schema for review.
- [ ] Complete legal, finance, tax, compliance, security, and support review.
- [ ] Implement and rehearse RFC 0009 recurring subscriptions.
- [ ] Implement and rehearse RFC 0012 overage under separate implementation
      authorization.
- [ ] Approve a separate production self-service activation runbook.

## 17. Primary references

- [Stripe Customer Portal](https://docs.stripe.com/customer-management)
- [Stripe subscription changes and pending updates](https://docs.stripe.com/billing/subscriptions/change)
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe-hosted subscription Checkout](https://docs.stripe.com/payments/checkout/build-subscriptions)
- [Stripe manual and localized currency pricing](https://docs.stripe.com/payments/checkout/localize-prices)
- [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
- [Coinbase explanation of the x402 flow](https://docs.cdp.coinbase.com/x402/how-it-works)
- [Coinbase CDP facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator)
