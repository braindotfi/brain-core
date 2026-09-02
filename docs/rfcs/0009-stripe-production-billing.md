# RFC 0009. Stripe production billing

- **Status:** Proposed. Specification only, no implementation.
- **Date:** 2026-09-02
- **Affects:** API usage billing, Stripe Billing, tenant entitlements, billing
  periods, commercial outcomes, invoicing, payment recovery, BrainMVB billing
  surfaces, security operations, finance operations, and customer contracts.
- **Related:** RFC 0007, RFC 0008, RFC 0010, RFC 0011,
  `docs/contracts/production-tenancy.md`, and migration
  `services/api/migrations/0025_api_billing_foundation.sql`.

## 1. Decision summary

Stripe is the payment processor and invoice system. Brain remains the
authoritative source for request facts, commercial outcome facts,
reconciliation, and the calculation of chargeable units.

The commercial model is hybrid:

1. A fixed recurring base price selects a public service tier.
2. Reconciled request units above that tier's included allowance are exported
   to a Stripe Billing Meter and charged as overage.
3. Explicitly defined successful business outcomes are exported to separate
   Stripe meters and priced independently from API request volume.

Stripe never receives raw gateway events. It receives idempotent aggregate
meter events only after Brain has durably recorded and reconciled the source
facts. A Stripe invoice is not allowed to outrun Brain's completeness checks.

Sandbox tenants and tenants with `access_stage=demo` remain zero-charge. A
tenant becomes billable only through the graduation gate in RFC 0010 and an
active Stripe subscription. There is no global switch that silently makes all
existing tenants chargeable.

This RFC does not approve prices, taxes, outcome definitions, dunning periods,
or a production billing start date. Those are explicit commercial, finance,
legal, and compliance decisions listed in section 12.

## 2. Existing RFC 0008 foundation

RFC 0008 already provides the required internal evidence chain:

- `api_request_meter_events` is the append-only source for known-key traffic.
- `api_usage_daily_rollups` provides reproducible daily aggregates.
- `api_usage_reconciliation_runs` compares raw events, rollups, limiter
  observations, gateway observations, and persistence failures.
- `api_billing_periods` closes an immutable tenant and environment period.
- `api_billing_adjustments` records reviewed corrections without rewriting
  historical facts.
- `api_metering_policies` versions the technical classification of billable
  requests.
- `tenant_api_entitlements` and immutable tier revisions define the rate-limit
  policy that applied to each request.

Today `requests_v1_shadow` can identify requests that would be billable, but
the request writer stores zero `billable_units`, and a shadow period must close
with zero `chargeable_units`. No existing table initiates a payment.

Production billing extends this model. It does not replace it with Stripe
event summaries or derive charges from the audit log.

## 3. Unit vocabulary and authority

The implementation must keep these concepts distinct:

| Term               | Definition                                                                            | Authority                                |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------- |
| Request fact       | One attributable gateway request and its outcome                                      | `api_request_meter_events`               |
| Billable unit      | A request that a versioned technical policy permits billing                           | Brain metering policy                    |
| Included unit      | A billable unit covered by the selected base tier                                     | Versioned commercial catalog             |
| Chargeable unit    | A billable unit remaining after included allowance, credits, and approved adjustments | Closed Brain billing period              |
| Stripe meter event | An idempotent aggregate exported from chargeable units                                | Stripe export outbox                     |
| Commercial outcome | A separately evidenced business result, not an HTTP outcome string                    | Outcome ledger described in section 6    |
| Invoice amount     | Base price, metered overage, outcome charges, tax, credits, and adjustments           | Stripe invoice, reconciled back to Brain |

`outcome=success` on an API request is not a commercial outcome. It only says
that an HTTP operation succeeded.

Add a billable request policy such as `requests_v2_billable`. It assigns
`billable_units=1` only when all approved conditions hold, initially:

- key environment is `live`,
- tenant `access_stage=production`,
- billing status permits service,
- request outcome is successful, and
- operation and scope are included in the published billing policy.

Client errors, core errors, dependency failures, scope rejections, rate-limit
rejections, invalid credentials, sandbox traffic, and demo traffic remain
recorded with zero billable units unless a future policy version explicitly
changes that rule. Closed periods are never reinterpreted under a later policy.

## 4. Stripe customer, catalog, and subscription model

### 4.1 Billing account

Create one Brain billing account for the legal customer relationship. A
billing account may be linked to the fresh production tenant and its retained
demo tenant, but only production tenants can consume a paid entitlement.

Store a stable mapping to one Stripe Customer. Do not use email as the join
key. Customer billing email changes in Stripe must never alter Brain login or
member identity.

Minimum local records include:

- billing account and tenant links,
- Stripe Customer id,
- Stripe Subscription id and status projection,
- fixed and metered Subscription Item ids,
- selected catalog version and tier,
- billing currency and tax treatment,
- current period boundaries,
- payment-method-present status without card details,
- delinquency state and access consequence,
- webhook high-water evidence, and
- timestamps and actor for every customer-initiated or operator change.

### 4.2 Products and prices

Each public tier maps to a versioned Brain catalog entry and an allowlisted set
of immutable Stripe Price ids:

- one recurring fixed Price for the base tier,
- one metered Price for request overage, and
- zero or more metered Prices for approved outcome types.

Stripe Price ids, included units, overage rates, currency, interval, and tax
behavior are immutable catalog data. A price change creates a new catalog
version and new Stripe Prices. Existing subscriptions remain pinned until an
explicit migration or customer plan change.

Brain computes `chargeable_units` after applying the tier allowance and sends
that quantity to the request-overage meter. Stripe must not independently
subtract another included allowance. This keeps Brain's closed period,
customer usage view, and Stripe quantity equal.

For example, if a monthly tier includes 100,000 units and a reconciled period
has 112,500 billable units, Brain closes 12,500 request chargeable units and
exports 12,500 to Stripe. Exact included quantities and prices remain a
commercial decision.

### 4.3 Tier changes inside a period

The entitlement timeline must be effective-dated. An upgrade cannot cause
the same usage to consume both the old and new allowance.

Recommended policy:

- upgrades take effect after successful payment confirmation,
- the fixed base price is prorated using a Stripe invoice preview and pending
  update,
- the old commercial segment closes at the effective timestamp,
- the new segment starts without resetting already consumed monthly units,
- the higher tier's total monthly allowance applies for the whole month, less
  units already consumed, and
- downgrades take effect at the next billing boundary.

Stripe documents that usage-based subscription items are not prorated in the
same way as fixed recurring items. Brain must therefore segment and reconcile
metered usage itself. The final upgrade policy needs commercial approval before
implementation.

## 5. Usage export and invoice reconciliation

### 5.1 Durable export outbox

Add a durable Stripe export outbox. Each row references a closed or reconciled
Brain source interval and contains:

- tenant and billing account,
- Stripe Customer and meter event name,
- unit type and quantity,
- UTC source interval,
- metering and commercial policy versions,
- source high-water marks,
- deterministic idempotency identifier,
- attempt count and last error,
- Stripe acknowledgement, and
- exported and reconciled timestamps.

The worker retries the same identifier. It never creates a fresh identifier to
work around an ambiguous timeout. Stripe processes meter events
asynchronously, so an accepted request is not evidence that an invoice summary
already reflects it.

### 5.2 Export cadence

Recommended cadence:

1. Reconcile and freeze each UTC day after its late-arrival window.
2. Export the day's newly chargeable request units in one aggregate event.
3. Export separately by commercial outcome type.
4. Reconcile Stripe meter summaries against the Brain export ledger.
5. During Stripe's invoice finalization grace period, close the final day and
   send any final delta.
6. Permit invoice finalization only when the Brain period is matched and all
   required export rows are acknowledged.

Stripe supports an invoice finalization grace period of up to 72 hours for
usage-based invoices. The selected grace period must be longer than Brain's
measured reconciliation and export latency, with an alert before the deadline.

Corrections discovered before invoice finalization use an idempotent delta or
supported meter adjustment. Corrections after finalization use a Brain billing
adjustment and a Stripe credit note or next-invoice adjustment. They do not
rewrite the original closed period. Stripe's meter cancellation window is
limited, so late corrections require an explicit finance workflow.

### 5.3 Webhook inbox

Stripe webhooks are asynchronous and may be retried. Add an append-only webhook
inbox keyed by Stripe event id. Verify the signature over the raw request body,
persist before processing, and make every projection update idempotent.

Handlers must tolerate duplicates and ordering differences. For access-changing
events, retrieve the current Stripe object when necessary instead of assuming
delivery order. Record processed status and errors without storing payment
instrument details.

Relevant events include Checkout completion, subscription creation and
updates, subscription deletion, invoice creation and finalization, invoice
payment success or failure, payment action required, and payment-method
changes. Browser success redirects never grant access.

## 6. Commercial outcome charges

### 6.1 Definition

A chargeable outcome is a durable, customer-attributable business result with
a terminal evidence condition. It is not an agent recommendation, an approval,
an attempted action, or a successful HTTP response.

Candidate outcome families are:

| Candidate           | Earliest defensible terminal evidence                                      | Main unresolved risk                                                          |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Collection resolved | Cleared settlement linked to the receivable                                | Attribution window, partial recovery, reversal, and percentage-fee regulation |
| Invoice processed   | Validated invoice posted to the customer's production ledger               | Whether this duplicates request or document-processing pricing                |
| Proposal executed   | UserOperation or rail execution reaches an approved terminal success state | Reorgs, reversals, failed settlement, and customer-caused cancellation        |

No candidate is approved for charging by this RFC. Product, finance, legal,
and customer-contract review must approve each outcome type and its evidence
rule separately.

### 6.2 Outcome ledger

Add a separate append-only, tenant-RLS commercial outcome ledger containing:

- stable outcome id and idempotency key,
- tenant, billing account, and subject id,
- outcome type and policy version,
- source service and immutable evidence references,
- occurred, confirmed, and reversed timestamps,
- quantity, amount, and currency when relevant,
- attribution window and responsible Brain action,
- status such as pending, confirmed, reversed, or disputed,
- price catalog version, and
- source audit ids without using the audit feed as the billing counter.

Only confirmed outcomes enter reconciled outcome rollups. A reversal creates a
new compensating record. It never deletes the original outcome.

Each outcome type uses a distinct Stripe meter and Price so invoices explain
the charge separately from API overage. Launch should start with fixed per-unit
outcomes. Percentage-of-recovered-value pricing is deferred until legal,
currency, refund, tax, and dispute rules are approved.

The commercial agreement and UI must state whether a customer can incur both
request overage and an outcome charge for the same workflow. This must not be
hidden as a technical implementation detail.

## 7. Payment collection, invoicing, and dunning

### 7.1 Payment method and invoices

Use Stripe-hosted Checkout to create the first paid subscription and collect
the payment method. Use the Stripe Customer Portal for payment-method updates,
invoice history, and cancellation where supported.

Brain must not collect or proxy card numbers, CVC, or bank credentials. Hosted
Checkout reduces PCI scope, but does not remove Brain's PCI obligations. The
final integration and annual PCI self-assessment scope require security and
qualified compliance review.

Usage-based subscriptions with multiple products have Customer Portal plan
change limitations. RFC 0011 therefore uses a Brain tier-selection UI backed
by server-side Stripe APIs, while still using Stripe-hosted pages for payment
entry and billing-document management.

### 7.2 Failed payments

Use Stripe Billing recovery and verified webhook state. Do not suspend service
on the first failed attempt.

Recommended state policy, pending commercial and legal approval:

- `active` and paid: full purchased entitlement.
- `past_due` within a configurable grace period: existing service continues,
  but new keys, tier increases, and spend-expanding changes are blocked.
- grace period expired, `unpaid`, or `canceled`: live write access and
  money-moving actions are suspended. Member access, invoice access, usage
  evidence, and data export remain available for a defined retention period.
- payment recovered: restore the subscribed entitlement idempotently after
  `invoice.paid` and active subscription confirmation.

Non-payment never deletes tenant data. Exact grace duration, read-only access,
notification schedule, collections process, and termination terms require
contract and legal review.

## 8. Shadow-to-billable gate

Billing activation is per production tenant and billing account. All of these
must be true:

1. Graduation under RFC 0010 is approved.
2. A Stripe Customer and active subscription are durably mapped.
3. The initial invoice is paid and a reusable payment method is present.
4. Terms, pricing version, currency, tax treatment, and billing contact are
   accepted and recorded.
5. The selected billable policy and catalog version are active.
6. At least the approved shadow observation period has matched gateway,
   limiter, raw meter, rollup, and export-simulation counts with zero
   persistence failures.
7. Stripe test-mode invoice simulations match Brain's expected base, overage,
   outcome, discount, tax, and adjustment quantities.
8. Monitoring, alerting, support, refund, dispute, and rollback runbooks are
   approved.

Activation writes an audited, effective-dated billing-mode transition. It does
not back-bill any earlier event.

Permanent free sandbox and demo tenants remain in shadow indefinitely. Their
`chargeable_units` and Stripe exports are always zero even if technical
`billable_units` are calculated for product analytics.

## 9. Security and compliance boundaries

- Stripe secret keys and webhook secrets use environment-scoped secret
  storage and gated rotation. They never enter repositories or client code.
- Hosted Checkout and Portal URLs are created only after an authenticated
  tenant-admin request and use allowlisted return URLs.
- Webhook endpoints verify signatures, rate limit invalid traffic, and retain
  only necessary event data.
- Billing tables with `tenant_id` use and force RLS. Cross-tenant finance jobs
  use a dedicated least-privilege role, not `brain_app`.
- Billing actions require step-up authentication or a recent authenticated
  session and emit immutable before and after audit records.
- Stripe Customer metadata contains opaque Brain ids, not ledger data or API
  secrets.
- Data retention, deletion, invoice retention, and subject-access handling are
  reviewed against applicable privacy and accounting rules.
- Tax registration, invoice wording, refunds, revenue recognition, sanctions,
  and jurisdiction availability are legal and finance responsibilities, not
  engineering defaults.

## 10. Required APIs and records

Implementation is expected to add, after separate schema review:

- billing accounts and tenant links,
- Stripe customer, subscription, invoice, and payment-status projections,
- immutable commercial catalog versions and Stripe Price mappings,
- Stripe webhook inbox and processing attempts,
- Stripe meter export outbox and acknowledgements,
- commercial outcome events, rollups, disputes, and reversals,
- billable period close and invoice reconciliation,
- billing-mode transitions and delinquency consequences, and
- customer-visible invoice and usage summaries that expose no Stripe secret.

Core must expose read endpoints for the authenticated tenant admin and narrow
mutation endpoints described in RFC 0011. Payment-provider calls stay behind a
billing service port so Stripe test doubles can exercise the full state
machine.

## 11. Sequencing and effort

Indicative engineering effort excludes legal, finance, tax, pricing, and
Stripe account review:

1. Commercial and compliance decisions: external gate, 2 to 4 engineer-days
   of support.
2. Billing schema, Stripe customer mapping, webhook inbox, and provider port:
   5 to 8 engineer-days.
3. Base subscription and hosted Checkout integration: 4 to 6 engineer-days.
4. Reconciled usage export and invoice matching: 6 to 10 engineer-days.
5. Dunning, access projection, notifications, and recovery: 4 to 7
   engineer-days.
6. First outcome type and reversal handling: 6 to 10 engineer-days after its
   commercial rule is approved.
7. Test-mode, test-clock, shadow, finance, and failure rehearsals: 5 to 8
   engineer-days.

RFC 0010 and RFC 0011 can overlap after the billing account, catalog, and
webhook contracts are stable. Outcome charging should follow stable request
overage billing, not launch simultaneously with it.

## 12. Decisions required before implementation

- Public tier names, currencies, intervals, base prices, included units, and
  overage rates.
- Whether annual plans are in the first release.
- Exact upgrade allowance treatment inside a billing period.
- Initial chargeable outcome, terminal evidence, price, reversal window, and
  dispute policy, or a decision to defer all outcome charges.
- Merchant legal entity, supported customer countries, tax registration, and
  whether Stripe Tax is required.
- Invoice finalization grace period and internal daily close deadline.
- Shadow qualification length. Recommendation: at least one complete monthly
  cycle plus failure rehearsals before the first real invoice.
- Dunning retry configuration, grace period, access degradation, notification,
  and termination policy.
- Refund, credit, goodwill adjustment, chargeback, and outcome-dispute
  authority.
- Payment methods and currencies allowed at launch.
- Accounting export, revenue-recognition owner, and invoice reconciliation
  sign-off.
- Required PCI assessor or internal security owner and privacy retention
  schedule.

## 13. Required validation

- The same Brain source interval cannot be exported twice under different
  identifiers.
- Stripe accepted quantities reconcile to closed Brain chargeable units.
- Invoice lines reconcile separately for base, request overage, and every
  outcome type.
- Sandbox and demo traffic can never produce a nonzero Stripe export.
- Unknown keys, rate-limit rejections, core failures, and meter failures remain
  nonchargeable under the initial policy.
- Duplicate and reordered webhooks produce one projection transition.
- A browser redirect without a verified webhook cannot activate service.
- Failed first payment cannot grant production access.
- Dunning and recovery transitions are idempotent and auditable.
- A late correction produces an adjustment, not mutation of a closed period.
- Stripe test clocks cover renewal, upgrade, downgrade, cancellation, failed
  payment, recovery, and final invoice cases.
- No card or bank credential reaches Brain logs, databases, traces, or client
  analytics.
- Standard typecheck, test, lint, invariants, RLS, OpenAPI, SDK, migration, and
  no-em-dashes checks pass.

## 14. Done and pending checklist

### Done in this RFC

- [x] Chose Stripe and the hybrid base, overage, and outcome model.
- [x] Kept RFC 0008 facts and reconciliation authoritative.
- [x] Defined chargeable units and the Stripe export boundary.
- [x] Defined an outcome ledger separate from request outcomes.
- [x] Scoped payment collection, invoicing, dunning, and access effects.
- [x] Defined per-tenant shadow exit and permanent free sandbox behavior.
- [x] Identified legal, compliance, finance, tax, and PCI gates.

### Pending approval or implementation

- [ ] Resolve every decision in section 12.
- [ ] Obtain legal, finance, tax, security, privacy, and PCI sign-off.
- [ ] Implement and review the billing schema and Stripe provider boundary.
- [ ] Rehearse the complete lifecycle in Stripe test mode.
- [ ] Complete the approved production shadow period.
- [ ] Approve a separate production billing activation runbook.

## 15. Primary references

- [Stripe usage-based billing overview](https://docs.stripe.com/billing/subscriptions/usage-based/how-it-works)
- [Stripe meter configuration](https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure)
- [Stripe meter event recording](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api)
- [Stripe invoice finalization grace period](https://docs.stripe.com/billing/subscriptions/usage-based/configure-grace-period)
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe Billing recovery](https://docs.stripe.com/billing/revenue-recovery/smart-retries)
- [Stripe-hosted Checkout](https://docs.stripe.com/payments/checkout)
- [Stripe Customer Portal](https://docs.stripe.com/customer-management)
- [Stripe integration security](https://docs.stripe.com/security/guide)
