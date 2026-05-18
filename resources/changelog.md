---
hidden: true
---

# Changelog

### v0.3 (current)

The v0.3 release introduces a Normalized Ledger between Raw and Wiki, splits Execution into a dedicated Agent layer, and adds the MCP server.

#### Added

* **Normalized Ledger layer.** Eleven entities: accounts, balances, transactions, counterparties, obligations, documents, categories, transfers, invoices, payment intents, reconciliation matches.
* **Payment Intents.** Agent-proposed financial actions live as Ledger rows, queryable like any other entity.
* **Pre-execution gate.** Deterministic 13-step check against live Ledger state before any payment executes.
* **MCP server.** `POST /v1/agents/mcp`, JSON-RPC 2.0 over single-shot HTTP. 10 tools, 5 resource templates, 5 canned prompts.
* **Agent contributions.** External agents with `raw:write` scope can push artifacts into the Raw layer with cryptographic attribution.
* **`/v1/audit/entity/{type}/{id}` endpoint.** Pull every audit event that touched a specific Ledger row.

#### Changed

* **Ledger is now the source of truth.** Wiki is downstream of Ledger and regenerable from Ledger plus Raw at any time.
* **Wiki no longer authoritative for financial state.** Wiki holds human-readable memory only; balances, transactions, and obligations come from Ledger.
* **Execution renamed to Agent.** The `services/execution` workspace is preserved for back-compat; new code lives in `services/mcp` and `services/execution` (both refer to the Agent layer).
* **Routes renamed.** `/agents/*`, `/payment-intents/*`, and `/agents/mcp` replace `/execution/*`. Legacy routes continue to work with deprecation headers.

#### Six layers (was five)

* v0.2 had five layers: Raw, Wiki, Policy, Execution, Audit.
* v0.3 has six: Raw, **Ledger**, Wiki, Policy, **Agent** (renamed from Execution), Audit.

### Migration from v0.2

| If you were using              | Use instead                        |
| ------------------------------ | ---------------------------------- |
| `/execution/propose`           | `/agents/{id}/propose`             |
| `/execution/execute`           | `/payment-intents/{id}/execute`    |
| `/execution/agents/*`          | `/agents/*`                        |
| `/execution/mcp`               | `/agents/mcp`                      |
| Wiki for current balances      | `brain.accounts.list` (Ledger)     |
| Wiki for transaction filtering | `brain.transactions.list` (Ledger) |

Legacy routes will be supported through 2026-Q2.

### Older versions

#### v0.2

* Five-layer protocol: Raw, Wiki, Policy, Execution, Audit
* Wiki was the source of truth for financial state
* MCP surface lived under `/execution/mcp`
