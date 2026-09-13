# Commercial financial evidence retention design

Status: proposed design only. No schema or deletion behavior changes are made
by this document.

This contract resolves the conflict between tenant erasure and the seven-year
retention required for Stripe billing, commercial charge, provider-command,
and x402 settlement evidence. It is a prerequisite for enabling either live
Stripe billing or live x402 settlement.

## 1. Current conflict

The current tenant-deletion service explicitly deletes these records before it
deletes the tenant:

- `commercial_stripe_subscriptions`
- `commercial_stripe_events`
- `commercial_charge_facts`
- `x402_payment_operations`
- `commercial_provider_commands`

Their tenant foreign keys also use `ON DELETE CASCADE`. That behavior conflicts
with the RFC 0009 and RFC 0012 requirement to retain accounting and settlement
evidence for at least seven years. `commercial_billing_accounts` already
survive final tenant unlink, but preserving that account alone does not retain
the facts needed to prove charges, payments, refunds, disputes, or provider
reconciliation.

Phase 1 schema work may remain disabled while this conflict exists. No
live-money feature may be enabled until the design below is implemented,
backfilled, and exercised against a disposable tenant.

## 2. Decision

Tenant retirement will erase the operational tenant and customer-facing data
while detaching a minimized, immutable financial-evidence record into a
separate retention subject. Retained evidence will not keep a foreign key to
`tenants` and will not be available through tenant application routes.

The database will own the transition. One fail-closed function will seal all
mutable provider state, create or reuse the retention subject, move every
required evidence row to its retained representation, verify row counts and
digests, unlink the billing account, and only then permit tenant deletion.

The design deliberately does not retain every provider payload. A seven-year
requirement is not permission to keep unnecessary personal data or secrets.
Only the allowlisted accounting and settlement fields below survive.

## 3. Retention identity

Add `commercial_retention_subjects` with:

| Field                   | Contract                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| `id`                    | Random opaque identifier, never derived from a tenant id                    |
| `former_tenant_digest`  | HMAC-SHA-256 of the tenant id under a dedicated retention pepper            |
| `billing_account_id`    | Nullable reference to the retained commercial billing account               |
| `retirement_receipt_id` | Unique link to the tenant-retirement receipt                                |
| `retired_at`            | Authoritative deletion timestamp                                            |
| `retain_until`          | At least seven years after the latest retained financial event              |
| `legal_hold`            | Defaults false; only a separately audited legal-hold operator may change it |
| `purged_at`             | Set only by the retention-expiry operator                                   |

The HMAC supports duplicate detection and controlled finance reconciliation
without exposing the original tenant id. The retention pepper is separate from
API-key, agent-key, and authentication secrets. Application services never
receive it.

## 4. Evidence boundary

### 4.1 Retain in minimized immutable form

| Source                                  | Retained fields                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stripe subscription projection          | Provider mode, Stripe object ids, catalog and price revision ids, status history, period boundaries, version, provider API version, event references, timestamps                                             |
| Stripe webhook inbox and event evidence | Event id, type, provider creation time, receive time, API and webhook versions, payload digest, signature-verification result, application outcome, attempt evidence, and an allowlisted accounting envelope |
| Commercial charge facts                 | Charge kind, fee policy, source-reference digest, basis and fee amounts, currency, state transitions, finality times, and source-evidence digest                                                             |
| x402 operations, quotes, and receipts   | Logical operation and quote ids, network, asset, recipient, atomic amount, payment digest, transaction hash, finality, fulfillment, refund, reconciliation, timestamps, and evidence digests                 |
| Provider commands                       | Provider, mode, command type, idempotency-key digest, allowlisted provider references, outcome, failure classification, attempts, and timestamps                                                             |
| Billing account                         | Existing retained account id, currency, closed state, final unlink, retention reason, and retention boundary                                                                                                 |

The retained envelope must never contain plaintext API keys, agent keys,
wallet private keys, Stripe secrets, webhook signing secrets, payment method
details, full email addresses, unbounded HTTP headers, or arbitrary request and
response bodies.

### 4.2 Erase at retirement

- tenant ids and entity ids after their HMAC linkage is verified
- customer-facing names, email addresses, and contact data
- unrestricted Stripe webhook payloads
- unrestricted provider command request envelopes
- payer metadata that is not needed to prove an onchain transfer
- transient retries, caches, session state, and credentials

Where a provider payload contains legally required evidence, an explicit
versioned extractor must copy only the required fields into the allowlisted
envelope. Unknown event or command types fail retirement closed until an
extractor version handles them. Missing classification must never be treated as
safe-to-retain.

## 5. Storage shape

Add append-only archive tables rather than weakening the operational RLS model:

- `commercial_retained_stripe_subscriptions`
- `commercial_retained_stripe_events`
- `commercial_retained_charge_facts`
- `commercial_retained_x402_operations`
- `commercial_retained_x402_events`
- `commercial_retained_provider_commands`

Every row references `commercial_retention_subjects`, carries the source row
id, a schema version, an evidence digest, `occurred_at`, `retained_at`, and
`retain_until`, and enforces uniqueness on source table plus source row id.
Update, delete, and truncate triggers make the tables immutable before expiry.
Compensations, refunds, disputes, and reconciliation corrections are new rows,
not edits.

Operational records keep their current tenant-scoped RLS. They are deleted
only after their archive representations have been inserted and verified.
This avoids nullable tenant identity and policy ambiguity in live operational
tables.

## 6. Retirement transaction

The tenant-deletion service must call one database function before any
commercial source row is deleted:

`prepare_commercial_financial_retention(p_tenant_id, p_retirement_receipt_id)`

The function runs in the tenant-deletion transaction and performs this exact
sequence:

1. Acquire an advisory lock for the tenant and lock its billing links and
   commercial provider rows.
2. Reject new billing and settlement work by marking the tenant commercially
   retiring through an immutable state transition.
3. Reject pending, dispatched, or otherwise unsettled provider work. Retirement
   pauses until it is canceled, completed, refunded, or placed under an
   explicit manual legal hold.
4. Create or idempotently load the retention subject.
5. Extract minimized evidence into the archive tables.
6. Re-read every source set and compare counts plus ordered content digests with
   the archive receipt. Any mismatch rolls back the transaction.
7. Close and unlink the billing account, extending its `retain_until` to the
   greatest retained-event boundary.
8. Write an append-only retention receipt containing per-table counts, digests,
   extractor versions, and the effective retention boundary.
9. Return success, after which the existing deletion plan may erase the
   operational rows and tenant.

The tenant row cannot be deleted unless a matching successful receipt exists
in the same transaction. Direct deletion remains denied to runtime roles.

Retries with the same tenant and retirement receipt are idempotent. A retry
with a different receipt while a successful receipt exists fails closed.

## 7. Access and privileges

Add a NOLOGIN group role named `brain_commercial_retention_worker` and a
separate short-lived operator identity that assumes it. It receives:

- `SELECT` on the explicit operational source columns needed by extractors
- `INSERT` on retention subjects, archive rows, and retention receipts
- `EXECUTE` on the sealed preparation and expiry functions
- no blanket table privileges and no tenant application role membership

`brain_privileged` remains read-only. Application, Stripe worker, x402 seller,
and tenant-deletion roles receive no direct archive mutation privileges.
Finance diagnostics receive bounded views that omit the former-tenant digest
unless a separately approved reconciliation requires it.

## 8. Expiry and legal hold

A protected `commercial-retention.yml` operator exposes fixed `inspect`,
`plan-expiry`, `apply-expiry`, and `verify` actions. Expiry requires an exact
production SHA, a reviewed manifest digest, a confirmation string, two-person
production approval, `retain_until < now()`, and `legal_hold = false`.

Deletion at expiry is the only permitted archive delete. It writes a
non-sensitive purge receipt with aggregate counts and digests before removing
the subject and evidence. The purge receipt contains no reversible tenant
identifier and may be retained indefinitely as proof that expiry occurred.

## 9. Migration and rollout plan

1. Add the retention subject, archive, receipt, role, and operator schema with
   all feature flags still false.
2. Backfill existing rows in bounded transactions. Verify per-table counts and
   digests without changing tenant deletion yet.
3. Add a dual-write observation that compares new archive extractors with
   operational facts but does not archive active-tenant rows permanently.
4. Switch tenant retirement to the transactional preparation function and
   remove the five evidence sources from unconditional deletion only after the
   archive receipt is verified.
5. Rehearse success, retry, unknown-payload, unsettled-command, legal-hold, and
   rollback cases on disposable test and staging tenants.
6. Enable live Stripe or x402 only after production inspect proves zero
   unclassified payload types and the expiry operator is installed but remains
   unused.

## 10. Required tests

- structural coverage proving all financial evidence tables are represented
- live Postgres coverage for locks, idempotency, rollback, immutability, and
  direct-delete denial
- fixture coverage for every supported Stripe event and provider command type
- proof that arbitrary payload and secret fields do not enter retained rows
- tenant retirement integration proving the tenant is erased while minimized
  evidence survives with no tenant foreign key
- digest and count mismatch tests that abort retirement
- pending settlement and pending provider-command tests that abort retirement
- seven-year boundary tests immediately before, at, and after expiry
- legal-hold tests that deny expiry
- role-matrix tests proving `brain_privileged` and runtime roles cannot mutate
  retained evidence

## 11. Activation gate

Before either `BRAIN_STRIPE_BILLING_ENABLED` or `BRAIN_X402_PAYMENTS_ENABLED`
may become true in production, an inspect receipt must prove:

- the retention schema and role postconditions are present
- no source event or command type lacks a versioned minimization extractor
- all existing financial rows are covered by verified counts and digests
- tenant retirement calls the fail-closed retention preparation function
- the protected expiry operator is installed
- no archive row has a tenant foreign key or disallowed sensitive field

Until then, both payment paths remain disabled.
