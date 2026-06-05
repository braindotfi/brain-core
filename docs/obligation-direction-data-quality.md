# Obligation direction: data-quality runbook

`ledger_obligations.direction` (`payable` | `receivable` | `NULL`) tells the §6
gate (check 6.7) and the creation-time gate in `PaymentIntentService` whether an
outflow is settling something **we owe** (a vendor, so `payable`, the only thing
a PaymentIntent may pay) versus something **owed to us** (a customer, so
`receivable`, the wrong-way drain the gate refuses). `NULL` means the direction
is unknown.

Since the creation-time gate refuses a new obligation-linked PaymentIntent whose
obligation is `NULL`/`receivable`, a stale `NULL` on a row that is _actually_ a
payable will wrongly block a legitimate payment. Keeping direction populated is
therefore a data-quality obligation, not just cosmetics.

## Where NULLs come from

1. The counterparty is neither `vendor` nor `customer` (bank / partner /
   internal). Genuinely underivable; an operator must classify it.
2. The obligation was written via a path that omits direction.
   `upsertObligationRow` takes it as optional and defaults `NULL`; today only
   the `doc_obligation_v1` extractor sets it.
3. The counterparty's type was corrected to `vendor`/`customer` **after** a
   backfill ran, so the row is now derivable but stayed `NULL`.

## Automatic re-derivation

Migration `services/ledger/migrations/0030_obligation_direction_rebackfill.sql`
re-derives direction for every still-`NULL` row from the **current** counterparty
type (idempotent: it only fills `NULL`s, never overwrites) and `RAISE NOTICE`s a
summary of what it backfilled and what remains, grouped by counterparty type.
Re-applying it (after fixing counterparty types) clears cases (3) above. Cases
(1) remain `NULL` by design.

## Standing monitoring query

Run as a **cross-tenant privileged role** (`brain_privileged` / `BYPASSRLS`).
This is an ops/admin data-quality report, the same cross-tenant pattern the
audit-anchor sweep and normalize worker use. Under `brain_app` (FORCE RLS) it
would only ever see the current `app.tenant_id`.

```sql
-- Remaining NULL-direction obligations by tenant + counterparty type.
SELECT o.owner_id                               AS tenant_id,
       COALESCE(c.type, '(no counterparty)')    AS counterparty_type,
       count(*)                                 AS null_direction_obligations
  FROM ledger_obligations o
  LEFT JOIN ledger_counterparties c ON c.id = o.counterparty_id
 WHERE o.direction IS NULL
 GROUP BY o.owner_id, COALESCE(c.type, '(no counterparty)')
 ORDER BY null_direction_obligations DESC;
```

## Remediation

- **Counterparty type wrong/missing** (rows under `(no counterparty)`, `bank`,
  `partner`, ...): correct the counterparty's `type` to `vendor`/`customer`
  where that is the true AP/AR relationship, then re-apply migration `0030` to
  re-derive direction.
- **Genuinely non-AP/AR obligation**: it should not back an outbound
  PaymentIntent; leaving direction `NULL` is correct and the creation-time gate
  refusing it is the intended outcome.

## Verification status

The migration's `UPDATE ... FROM` mirrors the proven 0029 backfill but is
applied, and its `NOTICE` output observed, only against a live Postgres
(CI DB-integration or a real deploy). It cannot be exercised in the sandbox
(no database).
