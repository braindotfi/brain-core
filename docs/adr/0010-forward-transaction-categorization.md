# ADR 0010: Transaction categorization is forward-only and auditable

- Status: Accepted
- Date: 2026-08-18

## Context

Ledger transactions have tenant-local `ledger_categories`, but no stable category
meaning across tenants and no assignment history. Description text is not a safe
financial classification source. In particular, Wiki must not answer period revenue
or expense questions by guessing from a memo.

## Decision

Brain maintains a versioned canonical taxonomy. Version 1 contains:

- `income.subscription_revenue`
- `expense.payroll_and_benefits`
- `expense.cloud_infrastructure`
- `expense.general_and_administrative`

Tenant-local `ledger_categories` remain the user-visible chart and gain an optional
`canonical_code`. Canonical codes do not replace tenant categories.

Each applied assignment is stored in `ledger_transaction_category_assignments`.
The active assignment sets `ledger_transactions.category_id`; a replacement
supersedes the former assignment and links it with `superseded_by`. Assignment
provenance records method, confidence, rule version, source value, and timestamps.
Direct and repair assignments emit `ledger.transaction.category_assigned`; canonical
source assignments remain traceable through the source record and assignment history.

Assignments use this priority order:

1. Explicit source-provided category values.
2. Versioned deterministic rules over typed source fields.
3. Human-confirmed corrections.
4. Optional inferred classifications are review-only proposals and never become an
   active category without confirmation.

The implementation is forward-only. New transactions may receive an explicit source
or deterministic assignment. Existing tenant history is not backfilled. Northstar
Labs is a one-time seed-data correction so its curated demo can answer the approved
category questions; it does not establish a general backfill precedent.

Wiki category totals and revenue-versus-expense comparisons fail closed when the
selected period has any posted cash-flow transaction without an active category
assignment. They query assignment rows, never transaction descriptions.

## Consequences

- A category answer is either traceable to a typed assignment or declined.
- A source update cannot silently replace a human correction, and a deterministic
  rule cannot replace either a source or human correction.
- Existing tenants will receive category answers only for periods with complete
  assignment coverage until a separately approved review or migration process exists.
- Taxonomy expansion is a versioned code change and ADR update, not a free-text
  category convention.

## Enforced by

- `shared/src/transaction-categories.ts`: version 1 canonical taxonomy.
- `services/ledger/migrations/0057_transaction_category_assignments.sql`: mapping,
  history, RLS, and active-assignment uniqueness.
- `services/ledger/src/categorization/assign.ts`: priority, lineage, and audit event.
- `services/canonical/migrations/0006_canonical_transaction_category_assignment.sql`:
  typed source metadata retained across projection.
- `services/wiki/src/question/orchestrator.ts`: category readers require complete
  coverage and use only active assignment rows.
