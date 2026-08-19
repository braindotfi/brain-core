# Northstar Labs Demo Data Inventory

Status: Phase 1 and Phase 2 design artifact. The runnable seeder is
`tools/seed-northstar-demo`.

## Scope

Northstar Labs, Inc. is a curated B2B SaaS and AI infrastructure tenant.
It is separate from the Brightline demo seed and the Golden Path developer seed.
Every value shown to a presenter must originate in the tenant's real core records.

| Surface             | Required backing records                                        | Northstar coverage                                                          |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Overview            | accounts, posted transactions, AP obligations, AR invoices      | Operating cash, 12 months of cash flow, AP and AR summaries                 |
| Ledger: Accounts    | `ledger_accounts`                                               | Operating account, reserve account, corporate card                          |
| Ledger: Payables    | payable `ledger_obligations` and vendor counterparties          | Seven named open obligations totaling $221,300.00                           |
| Ledger: Receivables | customer `ledger_invoices` and receivable obligations           | Five named open invoices totaling $530,500.00                               |
| Ledger: Cash Flow   | posted `ledger_transactions`                                    | Forty-eight monthly revenue and operating-expense records                   |
| Counterparties      | `ledger_counterparties`                                         | Six vendors, five customers, one tax authority                              |
| Inbox               | `proposals`, policy trace, audit events                         | Two evidence-backed Collections recommendations requiring review            |
| Policy              | one active tenant policy                                        | AP auto-allow through $10,000 for approved vendors, review otherwise        |
| Agents              | tenant agent registration                                       | Collections Agent used by pending Collections recommendations               |
| Forecasting         | accounts, cash-flow history, scheduled obligations, AR invoices | Deterministic cash runway and short-term AP and AR inputs                   |
| Wiki and Assistant  | tenant-scoped Ledger records                                    | Exact totals, overdue customer list, named vendor balances, cash-flow facts |
| Audit               | Ledger writes, policy insertion, proposal creation              | Standard emitted audit events and one policy activation event               |

## Existing Patterns Reviewed

- `tools/seed-golden-path` is a developer fixture that writes Accounts, Ledger,
  invoices, obligations, transactions, payment intents, documents, and audits. It
  is not reused because its consumer scenario does not match this tenant.
- `tools/demo-reset` resets and reseeds the unrelated Golden Path dataset. It is
  intentionally not invoked by the Northstar tool.
- `services/api/src/demo/brainsaas-seed.ts` shows the tenant-scoped policy,
  agent, proposal, and audit patterns used by the public demo. Northstar mirrors
  those core write contracts but has its own records and idempotency namespace.
- `services/internal-agents/src/registry.ts` contains the agent registry. The
  product workflows most relevant to this data are Collections, Invoice, Cash,
  and Close. The fixture creates real Collections proposals only and does not
  manufacture unsupported agent outcomes.
- `services/wiki/src/question/orchestrator.ts` answers from tenant-scoped Ledger
  data. The fixture supplies facts rather than special-case answers.

## Validation Boundary

The canonical amounts are fixed, while transaction, invoice, payable, policy,
agent, and proposal dates are generated relative to one seed timestamp. This
keeps a newly provisioned tenant current without changing the reconciled totals.
