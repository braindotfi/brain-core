# RFC 0011. Self-serve commercial tier selection and changes

- **Status:** Proposed. Specification only, no implementation.
- **Date:** 2026-09-02
- **Affects:** Tenant entitlements, Stripe subscriptions, BrainMVB Developers
  and Billing surfaces, member authorization, rate-limit enforcement,
  proration, cancellation, dunning, audit, and operator workflows.
- **Related:** RFC 0007, RFC 0008, RFC 0009, RFC 0010, and
  `.github/workflows/ops-api-entitlements.yml`.

## 1. Decision summary

An authenticated tenant admin may select, purchase, and change a published
commercial tier without operator intervention.

Self-service applies only to immutable public catalog versions and only when
the tenant and billing account are eligible. The browser never writes
`tenant_api_entitlements` directly and never proves payment by returning from
Stripe. Core validates the requested catalog transition, asks Stripe to make
the billing change, and projects the resulting paid subscription state into
the effective entitlement after verified webhooks.

The existing operator workflow remains for custom enterprise contracts,
fraud or compliance holds, exceptional overrides, credits, corrections, and
emergency suspension. Public self-service does not weaken the rule that key
overrides are restrictive unless a separately authorized commercial action
raises the tenant entitlement itself.

## 2. Why the control plane changes

RFC 0008 deliberately made entitlements operator-only because no customer
billing authority existed. That was correct for the shadow period. RFC 0009
adds Stripe subscription state and an immutable commercial catalog, so a
verified customer purchase can become an equally strong authority for a
published tier.

There are now two valid writers with separate permissions:

1. The self-serve billing controller applies catalog-backed changes requested
   by an authenticated tenant admin and confirmed by Stripe.
2. The operator controller applies reviewed internal actions that are not
   available in the public catalog.

Both use the same entitlement service, compare-and-set version checks,
idempotency, and `api_entitlement_change_log`. Neither updates rate-limit rows
with ad hoc SQL.

## 3. Public catalog

### 3.1 Catalog record

Expose only server-owned, effective-dated catalog entries. Each public tier
version contains:

- stable public tier id and immutable revision,
- display name and customer description,
- supported currency and monthly or annual interval,
- fixed base Price id,
- request overage meter and Price id,
- approved outcome meters and Price ids,
- included request units and overage unit price,
- key and tenant rate limits,
- source, storage, and Raw ingestion limits when applicable,
- feature flags and API scope eligibility,
- tax behavior,
- effective and retirement timestamps,
- permitted upgrade and downgrade targets, and
- whether graduation or additional review is required.

The client receives display-safe catalog data, never Stripe secret keys or
internal fraud thresholds. A catalog revision is immutable. New pricing creates
a new revision.

### 3.2 Eligibility

Core filters available tiers based on:

- tenant access stage and data profile,
- billing country and currency,
- graduation and verification state,
- subscription and delinquency state,
- unresolved compliance or fraud holds,
- public catalog availability,
- current contract or grandfathered price, and
- requested interval and supported payment methods.

The client cannot reveal a hidden tier by posting its id directly. Core repeats
all eligibility checks at preview and confirmation time.

## 4. BrainMVB experience

### 4.1 Read views

Tenant admins see:

- current server-owned tier and effective limits,
- billing period and renewal date,
- included, billable, and chargeable usage,
- projected overage based on reconciled data,
- current base price and currency,
- payment and delinquency status,
- pending upgrade, downgrade, or cancellation,
- available public tiers and exact differences, and
- links to invoices and payment-method management.

Non-admin members may see usage and the current tier if tenant policy allows,
but they do not see payment-method controls or mutation buttons.

### 4.2 Change flow

The public flow is:

1. Admin chooses a catalog tier.
2. Brain requests a server-side transition preview.
3. Core returns the exact immediate amount, credit, tax estimate, future base
   price, included usage effect, effective time, and any metered-usage caveat.
4. Admin confirms after a recent authenticated session or step-up check.
5. Core creates a Stripe Checkout Session, pending subscription update, or
   subscription schedule as appropriate.
6. Stripe collects any required payment or authentication.
7. Verified webhooks update the local subscription projection.
8. Core applies the effective entitlement once the approved paid state exists.
9. BrainMVB refreshes from core and displays the new state.

The success page is informational. It polls the core projection and cannot
grant itself the requested tier.

### 4.3 Stripe-hosted versus Brain-hosted controls

Use Stripe-hosted Checkout for first purchase and payment authentication. Use
the Stripe Customer Portal for payment-method updates, invoice history, and
supported cancellation tasks.

Stripe documents limitations on updating subscriptions that contain multiple
products or usage-based items. Because Brain's hybrid subscription has a base
item and metered items, BrainMVB needs its own tier comparison and change flow
backed by server-side Stripe APIs. Do not assume the Customer Portal can perform
every upgrade or downgrade.

## 5. Authorization and audit

Tier mutations require:

- authenticated member session,
- active tenant membership,
- `admin` role,
- recent authentication or approved step-up mechanism,
- CSRF protection on the BrainMVB BFF,
- idempotency key,
- expected entitlement and subscription version,
- no billing, fraud, or compliance hold, and
- explicit confirmation of the previewed amount and effective time.

API keys, agents, Slack, Teams, email, and WhatsApp surfaces cannot change a
commercial tier in v1. Financial subscription changes stay in the authenticated
web experience.

Every attempt records:

- tenant and billing account,
- authenticated member actor,
- requested catalog revision,
- before and proposed state,
- preview id and expiration,
- Stripe request and object ids,
- idempotency key,
- result and rejection reason,
- final webhook-confirmed state, and
- linked entitlement change audit id.

Do not store card details, Stripe client secrets, or hosted session URLs in the
audit output.

## 6. Upgrade policy

Recommended public upgrade behavior:

- upgrades may be requested immediately,
- Core previews fixed-price proration before confirmation,
- use a Stripe pending update when immediate payment is required, so the
  subscription change does not apply if payment fails,
- current limits remain until verified payment confirmation,
- the higher rate limits activate idempotently after paid subscription state,
- the higher monthly included allowance applies without resetting units
  already consumed in the same month, and
- request usage is segmented at the effective timestamp for invoice
  reconciliation under RFC 0009.

The product must show that usage-based items do not receive the same automatic
proration treatment as fixed recurring prices. Any immediate allowance policy
must be implemented in Brain's versioned commercial calculation and reconciled
to Stripe.

An upgrade requiring payment action remains pending. It does not optimistically
raise limits. If payment fails, the old subscription and entitlement remain.

## 7. Downgrade and cancellation policy

Recommended public downgrade behavior:

- schedule the downgrade at the next billing boundary,
- retain the current paid entitlement until that boundary,
- show whether current key count, usage, source count, or storage exceeds the
  target tier,
- prevent new activity that would deepen an over-limit state after the
  downgrade takes effect,
- never delete data automatically to satisfy a lower tier, and
- require the customer to resolve incompatible settings before the scheduled
  change, or cancel the schedule with a clear reason.

Recommended cancellation behavior:

- schedule cancellation at period end by default,
- include final metered usage in the final invoice,
- allow reversal of the cancellation before the boundary,
- transition live API access according to the approved non-payment and
  retention policy in RFC 0009,
- retain customer access to invoices, usage evidence, and data export for the
  contractually required period, and
- leave the free synthetic demo tenant separate and unaffected.

Immediate cancellation, refunds, and credits require a clearly disclosed
policy. Usage-based charges already incurred are not silently erased by a
downgrade or cancellation.

## 8. Abuse and financial safeguards

Self-serve upgrades increase both service capacity and Brain's upstream cost.
Controls should include:

- a small rate limit on preview and change endpoints,
- one active change workflow per billing account,
- idempotent Stripe mutations and version compare-and-set,
- no tier cycling to repeatedly reset included usage,
- no upgrade while past due or under a risk hold,
- payment confirmation before higher limits,
- a maximum public tier, with enterprise capacity requiring review,
- configurable spend and usage alerts,
- optional prepaid credit, deposit, or lower initial ceiling for high-risk
  accounts after finance and legal approval,
- velocity and linked-account checks using approved identifiers,
- rollback to the prior entitlement when a pending update fails, and
- operator emergency suspension that cannot be undone by self-service.

Safeguards must not silently use protected characteristics or undisclosed
consumer-credit scoring. Risk signals and denial handling follow RFC 0010.

## 9. Entitlement projection and consistency

Stripe is authoritative for payment and subscription state. Brain is
authoritative for enforced API entitlement state. A durable local projection
connects them.

The gateway never calls Stripe on the request path. It reads the local,
versioned entitlement already enforced by RFC 0008. A verified billing webhook
or a reconciler asks the shared entitlement service to apply a catalog-backed
change.

Required consistency rules:

- Stripe Customer, Subscription, Subscription Items, catalog revision, and
  tenant must all match.
- The expected current subscription and entitlement versions must match before
  applying a transition.
- Duplicate events return the existing result.
- Reordered events converge by retrieving or comparing current Stripe state.
- A nightly reconciler compares Stripe subscriptions with Brain billing and
  entitlement projections.
- Divergence blocks further self-serve changes and alerts billing operations.
- Entitlement changes never rewrite the request meter events that captured the
  prior effective tier.

## 10. Proposed APIs

Names are illustrative and require OpenAPI review:

- `GET /v1/billing/catalog`
- `GET /v1/tenants/{tenantId}/billing`
- `POST /v1/tenants/{tenantId}/billing/checkout-session`
- `POST /v1/tenants/{tenantId}/billing/change-preview`
- `POST /v1/tenants/{tenantId}/billing/change-confirm`
- `POST /v1/tenants/{tenantId}/billing/cancel`
- `POST /v1/tenants/{tenantId}/billing/cancel-reversal`
- `POST /v1/tenants/{tenantId}/billing/portal-session`

Mutation endpoints accept no arbitrary Stripe Price id, rate limit, included
units, or override. They accept a public catalog revision and a server-issued,
short-lived preview id.

BrainMVB proxies these with the authenticated session actor. It must not accept
an actor from the request payload.

## 11. What remains operator-only

The protected operator control plane remains the only path for:

- custom or negotiated enterprise tiers,
- limits above the public catalog maximum,
- key-specific exceptions that increase capacity,
- fraud, sanctions, compliance, or legal holds,
- manual graduation review and risk overrides,
- complimentary service, credits, refunds, and debt settlement,
- corrections to closed usage or outcome periods,
- outcome disputes and reversals outside the automatic window,
- grandfathered contract migration,
- currency or billing-interval exceptions,
- emergency suspension or restoration,
- forced cancellation, and
- repair of Stripe and Brain projection divergence.

Operator actions require the existing protected environment, least-privilege
role, independent review where policy requires it, reason, idempotency, and
immutable before and after logs.

The existing `ops-api-entitlements.yml` workflow should narrow to those cases.
It is not deleted when public self-service ships.

## 12. Sequencing and effort

Indicative engineering effort excludes pricing, legal, tax, and payment-policy
approval:

1. Catalog schema and read APIs: 3 to 5 engineer-days.
2. Subscription and entitlement projection state machine: 5 to 8
   engineer-days.
3. Preview, Checkout, pending update, and portal endpoints: 5 to 8
   engineer-days.
4. BrainMVB tier, usage, payment, and pending-state UI: 5 to 8 engineer-days.
5. Downgrade, cancellation, and recovery flows: 4 to 7 engineer-days.
6. Reconciliation, operator repair, and support tooling: 4 to 6 engineer-days.
7. Stripe test-clock, concurrency, and abuse rehearsals: 4 to 6 engineer-days.

Implement the public catalog and Stripe projection before exposing mutation
buttons. Launch upgrades first, then scheduled downgrades and cancellation
after invoice and access consequences have been rehearsed.

## 13. Decisions required before implementation

- Exact public tier catalog and maximum self-serve tier.
- Monthly, annual, or both billing intervals at launch.
- Upgrade timing, proration behavior, and included-allowance treatment.
- Downgrade eligibility when the tenant exceeds target limits.
- Default cancellation timing and refund policy.
- Whether payment method changes and invoices use only Stripe Portal or also
  have native Brain views.
- Recent-authentication duration and whether MFA is required for tier changes.
- Spend alert defaults and whether customers may set a hard budget cap.
- High-risk upgrade controls such as deposit, prepayment, or delayed limit
  activation.
- Which subscription, usage, and billing details non-admin members may view.
- Support and operator authority for failed, stuck, or disputed changes.
- Whether promotional codes, trials, credits, and annual prepayment are in the
  first release.

## 14. Required validation

- A non-admin, API key, agent, or surface actor cannot create or confirm a
  billing change.
- Posting an unpublished Price id, rate, or limit is rejected.
- A stale preview or entitlement version cannot mutate state.
- Duplicate confirmation and Stripe webhooks create one subscription change
  and one entitlement transition.
- Failed payment leaves the old entitlement in force.
- Successful paid upgrade changes the base subscription and rate entitlement
  exactly once.
- Usage before and after an upgrade reconciles without resetting or double
  consuming allowance.
- Downgrade occurs at the approved boundary and never deletes data.
- Cancellation produces a final usage invoice and the approved access state.
- Past-due or held accounts cannot self-upgrade around the restriction.
- Local entitlement and Stripe subscription divergence blocks mutations and
  alerts operators.
- The customer sees the exact previewed immediate and recurring amounts before
  confirmation.
- All actions emit session-derived actor and before and after audit evidence.
- Standard typecheck, test, lint, invariants, RLS, OpenAPI, SDK, migration, and
  no-em-dashes checks pass.

## 15. Done and pending checklist

### Done in this RFC

- [x] Chose self-serve public tier selection and upgrades.
- [x] Kept payment confirmation server-side and webhook-driven.
- [x] Defined admin authorization, audit, and idempotency requirements.
- [x] Addressed upgrade proration and metered-usage segmentation.
- [x] Addressed downgrade, cancellation, and abuse safeguards.
- [x] Preserved an operator-only boundary for exceptional actions.

### Pending approval or implementation

- [ ] Resolve every decision in section 13.
- [ ] Approve the immutable public catalog under RFC 0009.
- [ ] Complete legal, finance, tax, security, and customer-support review.
- [ ] Implement and rehearse the Stripe subscription projection.
- [ ] Implement BrainMVB only after the server contract is stable.
- [ ] Approve a separate production self-service activation runbook.

## 16. Primary references

- [Stripe Customer Portal capabilities and limitations](https://docs.stripe.com/customer-management)
- [Stripe Customer Portal configuration](https://docs.stripe.com/customer-management/configure-portal)
- [Stripe subscription changes and pending updates](https://docs.stripe.com/billing/subscriptions/change)
- [Stripe usage-based subscription management](https://docs.stripe.com/billing/subscriptions/usage-based/manage-billing-setup)
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe-hosted subscription Checkout](https://docs.stripe.com/payments/checkout/build-subscriptions)
