# RFC 0010. Self-serve production graduation

- **Status:** Proposed. Specification only, no implementation.
- **Date:** 2026-09-02
- **Affects:** Signup, tenant provisioning, production tenancy, business
  verification, risk review, Stripe subscription setup, Raw ingestion, API
  keys, member identity, BrainMVB onboarding, and customer support.
- **Related:** RFC 0002, RFC 0007, RFC 0008, RFC 0009, RFC 0011, and
  `docs/contracts/production-tenancy.md`.

## 1. Decision summary

Graduation is automated first and manual only when deterministic checks or a
reviewed risk model flag the application.

A graduated customer receives a fresh production tenant id. Brain never
changes a Brightline synthetic demo tenant into a customer-data tenant. The
demo tenant remains identifiable as synthetic, preserving the provenance and
trust boundary established by RFC 0007.

The production tenant starts empty of financial data. Members may carry their
identity and role invitation across the relationship, but synthetic Ledger,
Raw, source, audit, proposal, and agent records do not move. Production API
keys are newly issued and scoped to the fresh tenant.

Graduation requires an approved business verification result, an accepted
commercial tier, a Stripe payment method, and confirmed initial subscription
payment. A browser success page alone cannot activate production access.

The term KYB-lite in this RFC means a product risk screen, not a claim that
Brain has completed every legally required know-your-business, sanctions,
anti-money-laundering, or beneficial-owner check. Legal and compliance must
define the obligations for each supported jurisdiction before launch.

## 2. Current classification model

The current tenant classification fields are:

- `provisioning_state`, including `provisioning`, `ready_demo`, `seed_failed`,
  and `archived`,
- `data_profile`, including `synthetic_brightline_v1` and `customer`, and
- `access_stage`, including `demo`, `production_review`, and `production`.

These fields are sufficient to enforce Raw scope eligibility for the current
demo flow, but they do not represent a multi-tenant graduation request,
business evidence, risk review, payment state, or lineage between a demo and
production tenant.

Graduation therefore adds a separate workflow record. It must not overload a
single tenant row with both synthetic and customer-data history.

## 3. Proposed user journey

Only an active bootstrap or tenant admin member may start graduation. The flow
is:

1. The admin opens Upgrade to Production in BrainMVB.
2. Brain shows the production data boundary: a new tenant will be created and
   synthetic demo data will not transfer.
3. The admin supplies the business profile and verifies control of the
   business email domain.
4. Brain runs deterministic eligibility checks and a versioned risk screen.
5. Clear applications continue automatically. Flagged or ambiguous
   applications enter manual review with reason codes.
6. The admin selects an eligible public tier under RFC 0011.
7. Brain creates a Stripe-hosted Checkout Session for the approved catalog
   version.
8. Verified Stripe webhooks confirm the Customer, payment method,
   subscription, and paid initial invoice.
9. Core creates or activates the fresh production tenant and one active
   bootstrap admin in the same transaction.
10. The admin explicitly accepts or invites additional members. Core issues
    fresh live keys only after production activation.
11. The new tenant may ingest real Raw data. The demo tenant remains separate
    and visibly labeled synthetic.

Every step is idempotent. A refresh, repeated webhook, or retry cannot create
multiple production tenants or subscriptions.

## 4. Verification and risk model

### 4.0 Phase 1 implementation boundary

Phase 1 adds the tenant-scoped request, evidence, assessment, and manual-review
decision records plus member-session submit and status endpoints. Verification
is a versioned adapter contract. The initial composition proves control of the
authenticated member email and checks structural website-domain alignment.

The initial composition deliberately includes
`approved_compliance_policy_v1=compliance_policy_not_configured`, which routes
every otherwise-clear request to `manual_review`. It cannot approve production
access. Legal and compliance must supply the jurisdiction-specific check set,
provider adapters, reason codes, retention policy, and reviewer authorization
before any request can reach `clear` in a deployed environment.
Requests stopped by the pending policy can be reassessed under a later policy
version without replacing or mutating their earlier assessment evidence.

Phase 1 does not create a destination tenant, change the source tenant
classification, copy data, grant production Raw access, select a commercial
tier, or initiate payment. Those transitions remain in later phases.

### 4.1 Required evidence

Recommended minimum application fields are:

- legal business name,
- operating name when different,
- registration country and business address,
- company registration number when applicable,
- business website and primary email domain,
- billing contact and admin contact,
- intended Brain use case,
- expected API and financial-data volume,
- expected source systems and countries,
- confirmation that the applicant is authorized to bind the business, and
- acceptance of production terms, privacy terms, billing catalog, and data
  processing terms.

Do not collect beneficial-owner identity documents unless legal and compliance
have defined a requirement, vendor, retention period, access policy, and
deletion process.

### 4.2 Automated-first checks

The initial deterministic screen should include:

- email verification through a short-lived, single-use challenge,
- business-domain match between verified email, website, and declared entity,
- rejection or review of disposable and consumer mailbox domains,
- DNS and mail-domain viability,
- duplicate entity, domain, payment instrument, and tenant checks,
- supported country, currency, product, and data-residency checks,
- Stripe Customer and payment-risk signals allowed by the customer contract,
- sanctions or restricted-party screening only through an approved compliance
  process and provider,
- expected-volume reasonableness and known abuse patterns, and
- prior suspension, chargeback, or unresolved debt linked through approved
  identifiers.

A business email proves control of an inbox and domain. It does not prove legal
incorporation, ownership, authorization, or absence from sanctions lists.

### 4.3 Risk score and explainability

Store a versioned assessment with individual signals, reason codes, source,
confidence, and evidence timestamp. The result is one of:

- `clear`: continue automatically,
- `review`: require manual review,
- `blocked`: reject only for a reviewed hard rule, or
- `needs_information`: ask the applicant for specific missing evidence.

Do not use protected characteristics or opaque consumer-credit data. Do not
infer identity from phone number alone. Automated rejection criteria, appeal
rights, adverse notices, and data-retention duties require legal review in
every launch jurisdiction.

The customer sees a plain reason category and next step. Internal fraud signals
that would enable evasion may remain restricted, but support must have an
audited path to explain and reconsider a decision.

### 4.4 Manual review

Manual review is limited to flagged cases. Reviewers use a dedicated role and
see only evidence required for the decision. They can approve, request more
information, or deny with a reason. They cannot edit source evidence or bypass
required payment confirmation.

Reviewer identity, before and after state, reasons, evidence references, and
timestamps are immutable and tenant-attributed. High-risk overrides require a
second reviewer if compliance determines that dual control is necessary.

## 5. Fresh production tenant boundary

### 5.1 Required lineage

Add an immutable tenant relationship such as a `tenant_family` or graduation
link containing:

- graduation request id,
- source demo tenant id,
- destination production tenant id,
- billing account id,
- initiating member and approved admin,
- effective timestamp,
- classification snapshots, and
- evidence that no financial dataset was copied.

The relationship supports UI navigation and billing continuity. It does not
merge tenant RLS boundaries.

### 5.2 What may carry forward

Recommended allowlist:

- authenticated user identity reference,
- explicit admin acceptance and new member invitations,
- company display name and verified business profile,
- billing account and accepted terms,
- approved public tier selection, and
- optional nonfinancial preferences after a field-by-field privacy review.

The following never carry forward automatically:

- Ledger accounts, transactions, invoices, obligations, or balances,
- Raw documents, extracted data, or source records,
- synthetic policies or agent recommendations,
- proposals, approvals, or UserOperations,
- API keys, sessions, webhooks, or integration credentials,
- audit events or anchor state, and
- demo seeding timestamps or source provenance.

The production tenant audit log begins with its own creation and graduation
evidence references. The demo audit history remains queryable only inside the
demo tenant.

### 5.3 Provisioning sequence

Recommended sequence:

1. Create the graduation request and lock its idempotency key.
2. Complete verification and tier selection.
3. Complete Stripe Checkout and receive verified paid state.
4. In one database transaction, create the new `data_profile=customer`,
   `access_stage=production_review` tenant and bootstrap admin member.
5. Create production sessions and service principals through the existing
   production-tenancy contracts.
6. Verify required policies, audit chain, RLS, object namespace, and billing
   entitlement.
7. Transition the new tenant to `access_stage=production` through a guarded
   compare-and-set.
8. Permit live key issuance and real Raw ingestion.

If step 6 fails, the production tenant stays closed in `production_review`.
Retry repairs the same tenant. It does not create another tenant or relabel the
demo tenant.

## 6. Payment and tier gate

Graduation requires a public tier chosen from the server-owned catalog in RFC 0011. The browser creates no Stripe objects directly. Core creates a hosted
Checkout Session tied to the graduation request and expected Price ids.

Production activation requires:

- verified Checkout completion,
- Stripe Customer mapping,
- active Subscription projection,
- paid initial invoice,
- reusable payment method status,
- matching currency, catalog, tenant, and idempotency metadata, and
- no unresolved risk or compliance hold.

If payment requires additional authentication, the request remains pending.
If payment fails or the Checkout Session expires, no production access is
granted and the applicant may retry against the same graduation request.

A permanent free production tier, if ever offered, still requires an explicit
commercial catalog entry and legal approval. It must not be inferred from the
absence of a Stripe subscription.

## 7. Changes at graduation

### 7.1 Raw ingestion

The fresh production tenant becomes eligible for real customer Raw ingestion
only after activation. This requires a new production Raw scope policy distinct
from the current synthetic-demo exception:

- live key only,
- `data_profile=customer`,
- `access_stage=production`,
- active paid or explicitly approved entitlement,
- source and file limits from the selected tier, and
- malware, content, retention, and privacy controls approved for real data.

Demo `brain_sk_test_` keys remain bound to the demo tenant and synthetic data.
They cannot be converted into live keys or retargeted.

### 7.2 Entitlement and limits

The production tenant receives the selected paid entitlement. The demo tenant
retains its permanent free sandbox entitlement and does not share request
allowances or overage with production unless the commercial catalog later says
otherwise.

### 7.3 Customer experience

BrainMVB must show separate tenant labels, data profiles, billing state, keys,
usage, and sources. It must never present demo balances as migrated production
data. The graduation confirmation screen states that the production tenant is
empty until the customer connects or uploads real sources.

## 8. Required records and interfaces

Implementation is expected to add:

- `tenant_graduation_requests`,
- versioned business verification evidence,
- risk assessments and reason codes,
- manual review decisions,
- demo-to-production lineage,
- terms and catalog acceptance,
- Stripe Checkout and subscription references through RFC 0009 records, and
- idempotent provisioning attempts and failure evidence.

Expected member-session endpoints include:

- create or read the current graduation request,
- submit and verify business profile evidence,
- retrieve status and required next action,
- create an approved tier Checkout Session,
- cancel an uncompleted request,
- list the resulting demo and production tenant relationship, and
- request an audited manual reconsideration when policy permits.

Only tenant admins may mutate a request. API keys and agents cannot graduate a
tenant. Sensitive review details require a separate internal permission.

## 9. Security, privacy, and compliance gates

- Legal must define supported jurisdictions and what verification is actually
  required for Brain's products and financial-data processing.
- Compliance must approve screening providers, matching thresholds, manual
  review procedures, escalation, and record retention.
- Privacy must approve notices, purpose limitation, evidence fields,
  processors, cross-border transfers, access controls, and deletion handling.
- Security must review upload eligibility, account takeover resistance,
  step-up authentication, webhook trust, and reviewer permissions.
- Finance must approve payment-before-access, tax information, refunds, and
  handling of duplicate or failed subscriptions.
- Product and legal must define appeal and support commitments.

No engineer should label this flow legally sufficient KYB without those
approvals.

## 10. Sequencing and effort

Indicative engineering effort excludes vendor procurement and legal or
compliance review:

1. Evidence contract, state machine, and privacy review support: 3 to 5
   engineer-days.
2. Business verification and risk adapter ports: 5 to 8 engineer-days.
3. Graduation persistence and admin APIs: 5 to 8 engineer-days.
4. Stripe and tier handoff using RFC 0009 and RFC 0011: 4 to 6 engineer-days.
5. Fresh production tenant orchestration and lineage: 5 to 8 engineer-days.
6. Production Raw eligibility and key-policy changes: 4 to 7 engineer-days.
7. BrainMVB flow, status, and recovery UX: 5 to 8 engineer-days.
8. Abuse, failure, and manual-review rehearsals: 4 to 6 engineer-days.

The verification provider must remain behind an adapter. Initial deterministic
checks can ship before a vendor integration only if legal and compliance agree
that the launch markets and product do not require more.

## 11. Decisions required before implementation

- Supported launch countries, entity types, currencies, and prohibited uses.
- Exact mandatory business-profile fields by jurisdiction.
- Whether a registration-number lookup or third-party KYB provider is
  mandatory at launch.
- Sanctions and restricted-party screening owner, vendor, refresh cadence, and
  false-positive process.
- Risk signals, hard blocks, review thresholds, second-review requirements,
  and appeal policy.
- Evidence retention and deletion schedule.
- Whether verified configuration such as member invitations or policies may be
  copied, or whether launch should copy only identity and billing metadata.
- Whether the demo tenant remains indefinitely accessible after graduation or
  becomes read-only after a defined period.
- Production Raw source types, file limits, retention, and data residency.
- Whether the initial subscription must be paid or only authorized before the
  production tenant is created. Recommendation: require paid confirmation
  before activation, while allowing the closed `production_review` row to be
  created idempotently if orchestration needs it.
- Manual support service levels and reconsideration timeline.

## 12. Required validation

- A demo tenant id can never change from synthetic to customer data.
- Graduation creates at most one production tenant and one subscription for an
  idempotency key.
- Synthetic Ledger and Raw rows never appear in the production tenant.
- Demo keys cannot authenticate to the production tenant.
- Failed verification or payment cannot grant production access.
- Browser redirects without verified webhooks cannot advance payment state.
- Duplicate and reordered verification or Stripe events are harmless.
- Flagged applications stop at manual review with stable reason codes.
- An approved reviewer cannot bypass payment, RLS, or provisioning checks.
- Production Raw write remains closed until every graduation gate is true.
- A provisioning failure retries the same tenant and preserves evidence.
- All transitions emit authenticated actor and before and after audit records.
- Standard typecheck, test, lint, invariants, RLS, OpenAPI, SDK, migration, and
  no-em-dashes checks pass.

## 13. Done and pending checklist

### Done in this RFC

- [x] Chose automated-first verification with manual review for flags.
- [x] Chose a fresh production tenant instead of relabeling demo data.
- [x] Defined what may and may not carry forward.
- [x] Required paid Stripe state and a selected tier before activation.
- [x] Scoped real Raw ingestion and fresh live-key eligibility.
- [x] Identified legal, compliance, privacy, security, and finance gates.

### Pending approval or implementation

- [ ] Resolve every decision in section 11.
- [ ] Obtain jurisdiction-specific legal and compliance approval.
- [ ] Select and contract any required verification provider.
- [ ] Approve the production Raw data controls.
- [ ] Implement the workflow only after RFC 0009 and RFC 0011 contracts are
      stable.
- [ ] Rehearse approval, rejection, payment failure, retry, and rollback.

## 14. Primary references

- [Stripe subscription lifecycle and webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe-hosted subscription Checkout](https://docs.stripe.com/payments/checkout/build-subscriptions)
- [Stripe Customer Portal](https://docs.stripe.com/customer-management)
- [Stripe integration security](https://docs.stripe.com/security/guide)
