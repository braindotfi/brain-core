# RFC 0009. Stripe subscriptions and commercial invoicing

- **Status:** Implementation in progress. Phase 1 disabled contract foundation
  closed on 2026-09-03. Phase 2 observe-only work has begun.
  No Stripe credential, provider call, payment, or activation exists.
- **Date:** 2026-09-03
- **Affects:** RobotMoney base-tier subscriptions, outcome-fee invoicing,
  money-movement fee invoicing, billing accounts, Stripe customer and
  subscription state, tenant entitlements, invoicing, payment recovery,
  RobotMoney billing surfaces, finance operations, and customer contracts.
- **Related:** RFC 0007, RFC 0008, RFC 0010, RFC 0011, RFC 0012,
  `docs/contracts/production-tenancy.md`, and migration
  `services/api/migrations/0025_api_billing_foundation.sql`.

## 1. Scope revision and decision summary

Stripe covers recurring base prices, Enterprise invoices, and the approved
invoice collection path for approved outcome and money-movement fees. It does
not collect API or MCP overage, which remains an x402 payment.

The commercial payment split is:

| Charge                                                  | Rail                                        | Status in this RFC                          |
| ------------------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Free tier base price                                    | No payment                                  | Approved zero-price entitlement             |
| Starter, Growth, and Scale base price                   | Stripe subscription paid by card            | Approved for monthly and annual billing     |
| Enterprise base price                                   | Stripe invoice                              | Approved, operator-only negotiated pricing  |
| API and MCP use above or without allowance              | x402 exact USDC payment on Base mainnet     | Out of scope; RFC 0012                      |
| Collections-resolved and fraud-stopped outcome fees     | Stripe invoice add-ons                      | Approved for launch; pricing in section 3.2 |
| 0.3 percent on money moved plus foreign-exchange spread | RobotMoney revenue through Stripe invoicing | Approved mechanics in section 8             |

This revision supersedes the earlier design in which Stripe Billing Meters
received API overage. Stripe receives no raw gateway request events and no API
or MCP usage meter events. Stripe may receive finalized outcome and
money-movement invoice quantities from dedicated durable ledgers. Stripe
remains authoritative for card payment, invoice, and recurring subscription
state. Brain remains authoritative for the selected catalog revision,
chargeable facts, and service entitlements that follow from verified payment
state.

The durable event, reconciliation, and period-close foundation from RFC 0008
remains correct. Splitting payment rails changes what those records prove and
which provider adapter consumes them. It does not justify deriving commercial
state directly from Stripe, x402, or the audit feed.

## 2. What remains valid from the original design

The following foundations remain required:

- One stable billing account for the customer relationship, linked to one or
  more production tenants as the entity model is resolved under RFC 0011.
- Immutable, effective-dated RobotMoney catalog revisions.
- A stable mapping to a Stripe Customer and Subscription. Email is never the
  join key.
- An append-only Stripe webhook inbox keyed by Stripe event id.
- Idempotent subscription projections that tolerate duplicate and reordered
  webhooks.
- A durable command or outbox record for each Stripe mutation.
- Verified payment state before a paid base entitlement activates.
- Daily and monthly reconciliation between source facts, provider events, and
  the effective entitlement.
- Immutable billing-period close and compensating adjustments instead of
  rewriting closed history.
- Customer-visible subscription, usage, and payment state derived from the
  same facts used by enforcement and finance operations.

The reusable architecture is a shared commercial control plane with separate
provider adapters:

1. The catalog defines the tier and the independent charge components.
2. Stripe projects recurring base-subscription state.
3. RFC 0008 records API and MCP request facts and allowance consumption.
4. RFC 0012 records x402 quotes, authorizations, and settlements for overage.
5. Dedicated outcome and money-movement ledgers establish chargeable facts and
   export finalized invoice items to Stripe.
6. The entitlement service computes access from the applicable verified
   component states.

No provider's event stream is the canonical record for another provider's
charge.

## 3. What changes because payment rails are split

### 3.1 Stripe no longer receives request overage

Remove these concepts from the Stripe implementation scope:

- Stripe Billing Meters for API or MCP requests,
- Stripe metered Subscription Items,
- Stripe export outboxes for request quantities,
- invoice-line reconciliation for API or MCP overage, and
- Stripe proration rules for included API or MCP usage.

The RFC 0008 request meter, rollups, reconciliation runs, billing periods, and
adjustments are still needed. They now serve four purposes:

- decide whether included allowance remains,
- explain why a request was included, rejected, or required x402 payment,
- reconcile paid x402 calls against fulfilled operations, and
- support customer, finance, security, and dispute evidence.

For real-time x402 gating, a closed daily or monthly period is too late.
Allowance consumption needs an atomic request-path decision under RFC 0012.
Period close validates completeness and produces accounting evidence; it does
not trigger the x402 payment.

### 3.2 Launch outcome fees

Collections resolved and fraud caught or stopped both launch as optional
add-ons. Their payment rail is Stripe invoicing, not x402. A dedicated outcome
ledger distinguishes attempted work from a durable, customer-attributable
terminal outcome and exports only finalized quantities to Stripe.

The approved pricing and evidence policy is:

| Outcome              | Approved price                                                        | Chargeable definition                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection resolved  | 10 percent of net principal actually recovered                        | Cash attributable to RobotMoney collection activity has cleared into a customer-controlled account. Taxes, interest, partner fees, prior payments, refunds, and the separate 0.3 percent money-movement fee are excluded.                             |
| Fraud caught/stopped | 2 percent of verified prevented principal, minimum $10 and no maximum | RobotMoney caused a block, pause, recall, or recovery before final loss, and independent evidence confirms the attempted movement was fraudulent. A risk score, manual review, customer suspicion, or payment-partner-only decline is not sufficient. |

The 10 percent collection rate is intentionally below traditional
third-party collection contingency rates while preserving a direct
cash-recovery outcome. The fraud rate uses an uncapped proportional share of
verified loss prevented rather than charging for every screened transaction.

Approved evidence and timing:

- A collection is attributable when RobotMoney made a recorded collection
  action within 30 days before the payer committed to pay and the invoice was
  overdue when that action began.
- Collection principal becomes provisionally chargeable only after the receipt
  clears. It finalizes after a 30-day reversal window.
- A fraud incident requires the RobotMoney decision record plus independent
  evidence such as a payment-partner fraud determination, bank return reason,
  confirmed account-takeover report, or signed customer incident finding with
  supporting artifacts.
- Fraud evidence may arrive for 90 days after the prevented movement. The
  outcome finalizes when the qualifying evidence arrives.
- Finalized outcome fees are exported as itemized Stripe invoice lines in
  arrears each month, including for customers on annual base plans.
- Customers may dispute an outcome invoice line within 30 days. A reversal of
  recovered cash within 90 days of receipt, or evidence within 120 days that a
  fraud block was legitimate activity, creates a full compensating Stripe
  credit note. Closed source facts are never rewritten.
- The same workflow may incur API or MCP usage and an outcome fee because they
  purchase different things, but the invoice and usage views disclose both.

The percentage, definitions, attribution windows, minimum, uncapped fraud
treatment, and reversal rules are final design inputs for implementation.

### 3.3 Common evidence does not mean one settlement ledger

Provider-specific facts remain separate because they have different finality,
failure, and correction models:

| Fact                                      | Authority                                    | Correction model                                       |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| Recurring card payment and invoice        | Stripe                                       | Stripe refund, credit note, or subscription correction |
| API or MCP request and included allowance | Brain RFC 0008 records                       | Brain adjustment without rewriting request facts       |
| x402 payment authorization and settlement | x402 facilitator plus Base receipt           | Refund transfer or compensating commercial record      |
| Money-movement execution                  | Brain execution and payment-partner evidence | Rail-specific reversal or compensating settlement      |
| Chargeable commercial outcome             | Brain outcome ledger plus source evidence    | Compensating reversal, credit note, and dispute record |
| RobotMoney money-movement fee             | Brain fee ledger plus settled movement       | Compensating fee reversal and Stripe credit note       |

A normalized commercial journal may reference all of these records for
reporting. It must not erase their provider-specific evidence or claim that
card and onchain settlement have the same finality.

## 4. Stripe billing account and subscription model

### 4.1 Tier mapping and billing currencies

The approved USD monthly public base prices are:

| Tier       |              Monthly base price | Stripe treatment                           |
| ---------- | ------------------------------: | ------------------------------------------ |
| Free       |                              $0 | No Stripe subscription required            |
| Starter    |                             $99 | Fixed recurring subscription               |
| Growth     |                            $499 | Fixed recurring subscription               |
| Scale      |                          $2,500 | Fixed recurring subscription               |
| Enterprise | $10,000 to $50,000 custom range | Contracted, operator-only Stripe invoicing |

USD, EUR, and GBP are supported at launch. Monthly and discounted annual plans
exist for Starter, Growth, and Scale. The approved localized-price mechanism
is:

- Create explicit Stripe Prices for each tier, USD/EUR/GBP currency, and
  monthly/annual interval. Do not convert an invoice at payment time.
- Set annual public prices to ten times the monthly price, equivalent to two
  months free or a 16.67 percent discount.
- Derive initial EUR and GBP list prices from the 2026-09-03 current spot
  reference rate plus a 2 percent currency-risk buffer, rounded to two decimal
  places. Store the rate, timestamp, source, buffer, and rounding rule with the
  immutable price-book revision.
- Review localized prices quarterly. A revision changes prices for new sales;
  existing subscriptions remain pinned until an explicit migration or tier
  change.
- Lock billing currency for the subscription term. A self-serve currency
  change requires ending the old subscription at its boundary and creating a
  new subscription. It never rewrites paid invoices.

This fixed price-book approach makes the amount predictable and auditable. It
also avoids describing routine subscription pricing as a live FX spread. The
2 percent buffer and annual 10-times multiplier are approved.

Each paid public tier and billing interval maps to one immutable Stripe Price
per supported currency. A price change creates a new catalog revision and new
Stripe Prices. Enterprise terms are represented by operator-created Stripe
Quotes and invoices rather than public Price ids.

The Stripe catalog mapping does not contain API overage prices, outcome prices,
agent counts, entity counts, or execution-limit counters. Those are
RobotMoney catalog and entitlement dimensions under RFC 0011.

### 4.2 Local projection

Minimum local records planned for later schema review include:

- billing account and tenant links,
- selected RobotMoney catalog revision,
- Stripe Customer id,
- Stripe Subscription id and status,
- recurring Subscription Item and Price ids,
- monthly or annual billing interval and immutable localized price revision,
- current period boundaries,
- billing currency and tax treatment,
- payment-method-present state without card details,
- delinquency state and access consequence,
- webhook high-water evidence, and
- outcome-fee and money-movement-fee export high-water evidence, and
- actor, timestamps, idempotency, and before and after state for every change.

This RFC does not authorize schema changes yet.

### 4.3 Subscription lifecycle

Use Stripe-hosted Checkout to create the first paid subscription and collect
card authentication. Use the Stripe Customer Portal for payment-method changes,
invoice history, and supported cancellation operations.

The transitioning BrainMVB or RobotMoney surface may own tier comparison,
preview, and confirmation because RobotMoney entitlements span dimensions that
Stripe does not model. Core sends only an allowlisted Price id to Stripe. A
browser success page never activates access. Verified webhook state and
reconciliation are required.

Approved lifecycle:

- Free to paid: activate the paid tier only after the initial invoice is paid.
- Paid upgrade: apply immediately after successful same-day proration payment.
  New limits activate only from verified Stripe state.
- Paid downgrade: apply immediately with a same-day prorated
  credit applied to the Stripe customer balance, not a cash refund. Capacity
  remediation follows RFC 0011.
- Cancellation: continue access through the already-paid period, issue no
  unused-time refund, then automatically fall back to Free.
- Payment failure: restrict paid subscription entitlements immediately with no
  grace period. Preserve data and allow standalone x402 calls under RFC 0012.
- Promo codes and published trials may be self-serve. Larger credits and
  goodwill adjustments remain operator-only.
- Enterprise subscription changes, negotiated pricing, and credits remain
  operator-only even though invoices use Stripe.

Immediate paid-downgrade timing and customer-balance credit treatment are
approved.

An x402 balance or prior x402 payment does not prove that a Stripe subscription
is active. A Stripe subscription does not prove that a particular overage call
was paid.

## 5. Entitlement activation and graduation boundary

A production tenant may exist on Free without Stripe. A paid tier requires:

1. An eligible production tenant and billing account.
2. An accepted immutable catalog revision and applicable terms.
3. A verified Stripe Customer and active subscription mapping.
4. Confirmed initial payment for the selected recurring Price.
5. A successful compare-and-set entitlement transition.

RFC 0010's fresh-tenant graduation remains separable from payment. KYB trigger
criteria remain on Damon's separate compliance track. This RFC provides an
activation integration point for the approved result and does not change RFC
0010 or infer that tier selection triggers KYB.

## 6. Webhooks, reconciliation, and period close

Stripe webhooks are asynchronous and may be duplicated or reordered. Persist
the verified raw event envelope before processing, keyed by Stripe event id.
Handlers compare object versions or retrieve current Stripe state when delivery
order is ambiguous.

Relevant events include Checkout completion, subscription creation and update,
subscription deletion, invoice creation and finalization, invoice payment
success or failure, payment action required, refund, credit note, and
payment-method change.

Reconciliation is split by charge component:

- Stripe reconciliation compares recurring catalog price, subscription state,
  invoices, payments, refunds, and the base entitlement.
- RFC 0008 reconciliation compares gateway facts, allowance consumption, and
  fulfilled usage.
- RFC 0012 reconciliation compares x402 settlement receipts with overage calls.
- A consolidated monthly close confirms that the customer-visible statement is
  complete across components.

The consolidated close may lag real-time service decisions. It never grants
access and never retrospectively turns an unpaid request into a paid one.

## 7. Failed payments and access consequences

Approved policy:

- `active` and paid applies the purchased base-tier entitlement.
- The first verified subscription payment failure immediately removes paid
  incremental capacity. There is no grace period.
- Existing data is preserved. Excess agents and entities become paused or
  read-only under RFC 0011 rather than being deleted.
- Existing included-access API and MCP credentials follow the lower-tier
  revocation policy in RFC 0011.
- A delinquent tenant may still use standalone x402 exact payment, including
  while Stripe recovery is in progress. An x402 payment never restores the
  failed subscription entitlement.
- Stripe recovery retries and customer notifications continue even though the
  access restriction is immediate.
- Payment recovery restores the catalog-backed entitlement idempotently only
  after verified current Stripe state.
- A canceled subscription stays active through its paid period, then falls
  back to Free.

Approved notification policy: send an immediate failure notice, another after
24 hours, and a final notice before each Stripe-configured retry. Notification
delivery never delays the entitlement restriction.

## 8. The 0.3 percent money-moved fee and foreign-exchange spread

RobotMoney directly earns and collects the 0.3 percent fee on money moved
through agent accounts. It is not a payment-partner fee or revenue share.
Partner rail and foreign-exchange costs remain separate evidence.

Approved calculation and collection mechanics:

- Assess 0.3 percent against gross settled outgoing principal once per
  external money movement. Do not charge proposals, approvals, failed
  attempts, internal book transfers, refunds, taxes, partner fees, or the
  RobotMoney fee itself.
- Reserve the expected fee before execution so policy and available-balance
  checks use the all-in cost. Finalize it only from terminal settlement facts.
- Reverse the RobotMoney fee in full when the underlying movement is fully
  reversed or refunded. Apply a proportional reversal for a partial reversal.
- Record source amount, destination amount, gross principal, partner fees,
  RobotMoney fee, reference rate, customer rate, spread, and net settlement as
  separate values. Never infer RobotMoney revenue from a partner's net amount.
- Aggregate finalized fees monthly and export them as itemized Stripe invoice
  lines. For unusually large balances, Stripe invoicing may use an approved
  non-card payment method rather than forcing the subscription card.

Approved foreign-exchange economics:

- Use the executable payment-partner mid-market quote at the moment the user
  confirms the movement as the reference rate.
- Add a 0.50 percent RobotMoney FX spread for cross-currency execution. No FX
  spread applies when source and destination currencies match.
- Lock the quote for 60 seconds. After expiry, requote and require confirmation
  when the customer-facing destination amount worsens by more than 0.10
  percent.
- Apply the 0.3 percent money-movement fee to source-currency principal
  separately from the FX spread. Show both before approval and on the receipt.
- Use the actual settled partner rate for reconciliation. A favorable or
  unfavorable difference from the customer quote is recorded as FX economics,
  not silently added to the 0.3 percent fee.

The 0.50 percent spread, 60-second quote lock, 0.10 percent reconfirmation
threshold, and monthly Stripe collection path are approved. Damon's separate
compliance track supplies any jurisdiction, disclosure, or tax constraints
through the activation gates described in section 9.

## 9. Security and compliance boundaries

- Stripe secret keys and webhook secrets use environment-scoped secret storage
  and gated rotation. They never enter client code or audit output.
- Hosted URLs are created only after an authenticated tenant-admin request and
  use allowlisted return URLs.
- Billing records with `tenant_id` enable and force row-level security.
- Cross-tenant finance work uses a dedicated least-privilege role.
- Billing mutations require recent authentication or approved step-up,
  idempotency, compare-and-set versions, and immutable actor attribution.
- Stripe metadata contains opaque Brain identifiers, not Ledger data, x402
  payment payloads, or API secrets.
- Compliance-owned launch countries, KYB trigger criteria, tax registrations,
  merchant entity, and Stripe Tax configuration are not scoped here. The
  billing activation gate consumes their approved configuration when Damon
  completes that track.
- Damon is the single accountable owner at acceptance. Finance Controller,
  Billing Engineering, Treasury, Security, Product, client surface, Core, and
  Platform are responsibility labels, not claims that separate role-holders or
  teams exist today.
- Each approval, close, reconciliation, deployment, and exception stores both
  the stable responsibility label and authenticated actor. A later assignment
  registry may delegate any label to another person without changing billing
  records, workflows, schemas, or evidence contracts. Until delegation is
  explicit, every label resolves to Damon.
- The initial assignment uses authenticated actor
  `user_01M0NTPB2292Z4BF5BHVEM41C6`, Damon's most recently active production
  admin principal at the 2026-09-03 read-only diagnostic.
- Stripe-hosted Checkout, Portal, Quotes, and invoices keep card data outside
  Brain. The implementation targets PCI SAQ A scope. Damon signs off under the
  Security responsibility label before activation.

## 10. Planned API boundary

Names are illustrative and require later OpenAPI review:

- `GET /v1/billing/catalog`
- `GET /v1/tenants/{tenantId}/billing`
- `POST /v1/tenants/{tenantId}/billing/checkout-session`
- `POST /v1/tenants/{tenantId}/billing/change-preview`
- `POST /v1/tenants/{tenantId}/billing/change-confirm`
- `POST /v1/tenants/{tenantId}/billing/cancel`
- `POST /v1/tenants/{tenantId}/billing/cancel-reversal`
- `POST /v1/tenants/{tenantId}/billing/portal-session`

Mutation endpoints accept a public catalog revision and server-issued preview,
never an arbitrary Stripe Price id or entitlement value. API and MCP overage
payment headers and settlement endpoints belong to RFC 0012, not this API.

## 11. Approved implementation decisions

- Annual public price equals ten monthly payments, a 16.67 percent discount.
- Fixed USD/EUR/GBP price books use the 2026-09-03 current spot reference rate,
  2 percent risk buffer, two-decimal rounding, quarterly review, and immutable
  catalog revisions.
- Paid downgrades apply immediately with customer-balance credit rather than a
  cash refund.
- Failed-payment notices follow the cadence in section 7.
- Collections resolved costs 10 percent of qualifying net recovered principal
  under the attribution and reversal rules in section 3.2.
- Fraud caught or stopped costs 2 percent of verified prevented principal,
  with a $10 minimum and no maximum, under section 3.2.
- Outcome fees and RobotMoney money-movement fees are itemized monthly through
  Stripe even when the recurring base plan is annual.
- The 0.3 percent fee uses the assessment and reversal rules in section 8.
- Cross-currency money movement adds a 0.50 percent RobotMoney spread to a
  60-second executable partner quote, with reconfirmation after an adverse
  move greater than 0.10 percent.
- Damon owns every responsibility label assigned in section 9 until an explicit
  future delegation changes the assignment registry.
- Removing a billing account's final tenant link starts the same seven-year
  retention period used for accounting and settlement evidence.

Compliance-owned launch countries, KYB trigger criteria, tax registrations,
merchant entity, and Stripe Tax configuration remain outside this commercial
decision register. The implementation exposes configuration and activation
gates for those separately supplied inputs without inventing defaults.

## 12. Stripe workstream checkpoints

### Checkpoint A. Contracts and sandbox foundation

- Approve the later schema and OpenAPI changes separately.
- Configure Stripe test-mode Products, monthly and annual Prices, localized
  price books, Tax integration points, promotion codes, and webhook endpoints.
- Implement provider commands, webhook inbox, idempotent projection,
  responsibility-label assignments, and reconciliation with all mutations
  fenced to Stripe test mode.
- Use Stripe Test Clocks to exercise monthly and annual transitions, upgrades,
  downgrades, cancellation, failed payment, and recovery.

### Checkpoint B. Subscription shadow

- Generate subscription previews and expected entitlement transitions without
  creating live subscriptions.
- Compare Brain projections with Stripe test objects and catalog revisions.
- Run at least 30 days or two accelerated complete billing cycles, whichever
  gives broader lifecycle coverage.
- Exit only with zero unexplained projection divergence and replay-safe webhook
  processing.

### Checkpoint C. Internal live subscription canary

- Enable live Stripe only for allowlisted RobotMoney-owned tenants.
- Use low-value monthly and annual purchases, refunds, prorations, payment
  failures, and cancellation rehearsals.
- Reconcile daily and require Damon to sign off under the Finance Controller,
  Billing Engineering, and Security responsibility labels.

### Checkpoint D. Fee shadow

- Compute Collections, fraud, 0.3 percent movement, and FX charges from real
  production facts without exporting invoice items.
- Run at least 30 days and independently review every chargeable outcome and a
  risk-based sample of nonchargeable outcomes.
- Exercise all reversal, credit-note, and dispute paths with test invoices.

### Checkpoint E. Limited customer billing

- Enable subscriptions and fee invoicing for a small allowlisted cohort.
- Keep daily reconciliation, customer-visible evidence, automatic restriction,
  and operator repair ready before expansion.
- Do not enable outcome or movement fee export until the fee-shadow checkpoint has no
  unexplained quantity or attribution difference.

### Checkpoint F. General availability

- Expand through a separate production activation runbook after RFC 0011 and
  RFC 0012 gates pass and the compliance inputs are present.
- Preserve daily reconciliation and immutable monthly close after launch.

## 13. Required validation for a later implementation

- A browser redirect without a verified webhook cannot activate a paid tier.
- A Free tenant cannot accidentally create a paid Stripe subscription.
- Each Stripe event produces at most one projection transition.
- Reordered events converge on current Stripe object state.
- Failed first payment leaves the prior entitlement in force.
- A Stripe invoice contains no API or MCP x402 overage.
- Every outcome or money-movement invoice line maps to a finalized Brain fact
  and never to an attempt, proposal, risk score, or unsettled movement.
- Stripe subscription state cannot satisfy an x402 payment requirement.
- An x402 settlement cannot satisfy recurring subscription payment.
- Upgrade, downgrade, cancellation, failure, and recovery transitions are
  idempotent and auditable.
- No card credential reaches Brain logs, databases, traces, or analytics.
- Consolidated statements reconcile without treating unlike provider finality
  as one event type.
- Monthly and annual price books present the approved USD, EUR, and GBP amount
  without invoice-time currency drift.
- Outcome disputes and movement reversals create compensating records and
  Stripe credit notes without rewriting closed history.
- Standard typecheck, test, lint, invariants, row-level-security, OpenAPI, SDK,
  migration, and no-em-dashes checks pass when implementation begins.

## 14. Done and pending checklist

### Done in this revision

- [x] Limited Stripe request overage scope to no API or MCP usage.
- [x] Added Enterprise, outcome-fee, and money-movement invoicing.
- [x] Preserved RFC 0008 durable facts, reconciliation, and period close.
- [x] Removed Stripe meters as the assumed API and MCP overage rail.
- [x] Separated provider-specific evidence from consolidated reporting.
- [x] Incorporated RobotMoney ownership of money-movement fees.
- [x] Approved Collections pricing, uncapped fraud pricing, and FX mechanics.
- [x] Assigned every responsibility label to Damon with a delegable registry
      boundary.
- [x] Flagged the RFC 0010 KYB trigger question without changing RFC 0010.
- [x] Added the disabled billing-account, Stripe projection, durable event,
      provider-command, charge-fact, and responsibility-assignment contracts.

### Pending implementation and activation review

- [x] Closed every commercial and technical decision in section 11.
- [ ] Complete legal, finance, tax, compliance, security, and support review.
- [x] Reviewed the Phase 1 billing schema against the split-rail model.
- [ ] Implement and rehearse Stripe under separate implementation
      authorization.
- [ ] Approve a separate production billing activation runbook.

## 15. Primary references

- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe subscription changes and pending updates](https://docs.stripe.com/billing/subscriptions/change)
- [Stripe-hosted subscription Checkout](https://docs.stripe.com/payments/checkout/build-subscriptions)
- [Stripe Customer Portal](https://docs.stripe.com/customer-management)
- [Stripe Billing recovery](https://docs.stripe.com/billing/revenue-recovery/smart-retries)
- [Stripe integration security](https://docs.stripe.com/security/guide)
- [Stripe manual and localized currency pricing](https://docs.stripe.com/payments/checkout/localize-prices)
- [Stripe recurring pricing models](https://docs.stripe.com/products-prices/pricing-models)
- [Stripe Radar pricing benchmark](https://stripe.com/radar/pricing)
- [FTC debt-collection contingency-fee benchmark](https://www.ftc.gov/sites/default/files/documents/public_events/debt-collection-protecting-customers/dcwr.pdf)
- [x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
