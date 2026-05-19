# Brain JSON Schemas

This directory holds JSON Schemas for two layers in the v0.3 architecture:

- **Ledger entities**: schemas under `entity/` validate `attributes` for
  the eleven Layer-2 entities. Authoritative for financial truth.
- **Wiki page types**: schemas under `page/` validate the structure of
  rendered memory pages (Layer 3).

Schemas under `relation/` are retained from v0.1 for the bitemporal Wiki
relation graph during the v0.3 transition. Most of those concepts move
into Ledger entities (e.g. the `transacted_with` relation is recoverable
from `ledger_transactions.account_id` + `ledger_transactions.counterparty_id`).
The `relation/` directory will be deprecated after refactor-3 lands.

## Ledger Entity Kinds (Layer 2)

| Kind                 | Schema                            |
| -------------------- | --------------------------------- |
| account              | `entity/account.schema.json`      |
| balance              | (added in refactor-2)             |
| transaction          | `entity/transaction.schema.json`  |
| counterparty         | `entity/counterparty.schema.json` |
| obligation           | `entity/obligation.schema.json`   |
| document             | (added in refactor-2)             |
| category             | (added in refactor-2)             |
| transfer             | (added in refactor-2)             |
| invoice              | (added in refactor-2)             |
| payment_intent       | (added in refactor-4)             |
| reconciliation_match | (added in refactor-5)             |

The `policy` and `agent` schemas in `entity/` are pointer types, they
reference the canonical records in `services/policy/` and
`services/agent/` respectively. They remain in Wiki for backwards
compatibility and are queryable as Ledger entities post-refactor.

## Wiki Page Types (Layer 3)

| Slug pattern                   | Page type       |
| ------------------------------ | --------------- |
| `/accounts/{account_id}`       | account         |
| `/counterparties/{cp_id}`      | counterparty    |
| `/obligations/{obl_id}`        | obligation      |
| `/invoices/{inv_id}`           | invoice         |
| `/agents/{agent_id}`           | agent           |
| `/policies/{policy_id}`        | policy          |
| `/monthly-summaries/{YYYY-MM}` | monthly_summary |
| `/cash-flow/{period}`          | cash_flow       |

Every page body should include the standard Brain memory page sections:
Current Truth, Key Linked Entities, Recent Activity, Open Questions /
Missing Evidence, Risk Notes, Timeline, Evidence Links.

## Provenance Values

- `extracted`, derived from a Raw artifact via the parser pipeline
- `inferred`, produced by reasoning, with no direct evidence row
- `ambiguous`, multiple candidate values; resolution pending
- `human_confirmed`, manually annotated via `/wiki/annotate`
- `agent_contributed`, produced by an external agent (capped at 0.5 confidence)

Agent-contributed Ledger rows start at a confidence ceiling of 0.5. Promotion
requires corroboration or explicit tenant approval. Enforced in the Ledger
write path, per Brain_Engineering_Standards.md §3.2.

## Relation Kinds (Deprecated; v0.1 Carry-Forward)

The four legacy relation kinds, `transacted_with`, `owes`, `owed_by`,
`governed_by`, remain queryable in `services/wiki/` until refactor-3
removes them. New code should query Ledger directly:

| Legacy relation   | v0.3 Ledger query                                                  |
| ----------------- | ------------------------------------------------------------------ |
| `transacted_with` | `ledger_transactions WHERE account_id = X AND counterparty_id = Y` |
| `owes`            | `ledger_obligations WHERE direction = 'payable'`                   |
| `owed_by`         | `ledger_obligations WHERE direction = 'receivable'`                |
| `governed_by`     | `ledger_payment_intents.policy_decision_id` join                   |
