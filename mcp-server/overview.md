# Overview

Brain is a financial intelligence **Model Context Protocol (MCP) server** for the autonomous economy. It gives AI agents a secure, permissioned interface for understanding financial activity, retrieving structured financial memory, enforcing user-defined policies, and supporting autonomous execution with verifiable audit trails. A financial brain for AI agents. \
\
Connect once to Plaid, Alchemy, Chainalysis, and your existing rails. Brain handles the rest. \
Agents propose actions. Policies decide what runs. Humans stay in control.

| Property              | Value                                            |
| --------------------- | ------------------------------------------------ |
| **Endpoint**          | `POST /v1/agents/mcp`                            |
| **Transport**         | JSON-RPC 2.0 over single-shot HTTP               |
| **Backed by**         | The same Ledger, Wiki, and PaymentIntent surface as the HTTP API |

{% hint style="info" %}
The MCP surface uses single-shot HTTP. One request, one response, one audit event. Streaming transports may follow once we see a use case that needs them.
{% endhint %}

### Surface map

The MCP surface is intentionally small. **10 tools, 5 resource templates, 5 canned prompts.**

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛠️ 10 Tools</strong></td><td>Five Ledger reads, two Wiki reads, one Raw contribute, one PaymentIntent propose, one agent action propose.</td><td><a href="tools.md">tools.md</a></td><td></td></tr><tr><td><strong>📦 5 Resources</strong></td><td>Resource templates addressable by <code>brain://</code> URIs: accounts, transactions, payment-intents, wiki pages, raw evidence.</td><td><a href="resources.md">resources.md</a></td><td></td></tr><tr><td><strong>💬 5 Prompts</strong></td><td>Canned prompts for the most common agent loops: cash flow, bills, spending, invoices, subscriptions.</td><td><a href="prompts.md">prompts.md</a></td><td></td></tr><tr><td><strong>🪪 Authentication</strong></td><td>JWT plus on-chain scope hash verification against <code>BrainMCPAgentRegistry</code>.</td><td><a href="mcp-authentication.md">mcp-authentication.md</a></td><td></td></tr></tbody></table>

### What an external agent can do

| Capability               | Tools                                                                                                                             | On-chain Scope           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Read Ledger**          | `ledger.account.get`, `ledger.accounts.list`, `ledger.transactions.list`, `ledger.obligations.list`, `ledger.counterparties.list` | `ledger:read`            |
| **Read Wiki**            | `wiki.question`, `wiki.page.get`                                                                                                  | `wiki:read`              |
| **Contribute to Raw**    | `raw.contribute`                                                                                                                  | `raw:write`              |
| **Propose payment**      | `payment_intent.propose`                                                                                                          | `payment_intent:propose` |
| **Propose agent action** | `agent.action.propose`                                                                                                            | `agent:propose`          |

{% hint style="warning" %}
There is no `payment_intent.execute` on the MCP surface. External agents may **propose** but never **execute**. Execution always goes through Brain's deterministic 13-step pre-execution gate, behind human approval where policy demands it.
{% endhint %}

[**→ The Pre-Execution Gate**](../protocol/the-pre-execution-gate.md)

### What makes the MCP surface different

The MCP tools call the same Ledger, Wiki, and PaymentIntent code paths that back the HTTP API. That has three concrete consequences:

| Property                     | Effect                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Identical Policy gating**  | A `payment_intent.propose` over MCP runs through the same Policy evaluator as one created via HTTP                       |
| **Identical audit emission** | Tools that mutate state emit the same inner audit events the HTTP API emits, plus an outer `agent.mcp.tool_called` event |
| **No bypass path**           | There is no shortcut. MCP cannot skip Policy or write to the Ledger directly.                                            |

### Architecture

```
        ┌─────────────────────────────────┐
        │  External AI Agent              │
        └────────────┬────────────────────┘
                     │  JSON-RPC 2.0 over HTTPS
                     │  Authorization: Bearer <jwt>
                     ▼
        ┌─────────────────────────────────┐
        │  Brain edge                     │
        │  Validates JWT, resolves        │
        │  principal (tenant + scopes)    │
        └────────────┬────────────────────┘
                     │
                     ▼
        ┌─────────────────────────────────┐
        │  MCP dispatcher                 │
        │  - Method routing               │
        │  - 3 pre-call checks:           │
        │    a) agent active              │
        │    b) JWT scope_hash matches    │
        │       on-chain hash             │
        │    c) JWT tenant == agent       │
        │       tenant                    │
        │  - Per-tool scope enforcement   │
        └────────────┬────────────────────┘
                     │
                     ▼
        ┌─────────────────────────────────┐
        │  Shared Brain services:         │
        │  Ledger reads & writes          │
        │  Wiki Q&A and pages             │
        │  PaymentIntent proposal flow    │
        └─────────────────────────────────┘
                     │
                     ▼
            Audit events emitted at every step
```

### A first call

```http
POST /v1/agents/mcp HTTP/1.1
Host: api.brain.fi
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "wiki.question",
    "arguments": {
      "tenant_id": "acme",
      "question": "What's our top expense category this month?"
    }
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "AWS at $61,404 across 3 environments." }
    ],
    "metadata": {
      "ledger_evidence": [
        { "type": "ledger_transactions", "id": "tx_4127" },
        { "type": "ledger_transactions", "id": "tx_4128" }
      ],
      "audit_event_id": "evt_a1b2c3..."
    }
  }
}
```

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛠️ Tools</strong></td><td>The 10 tools in detail.</td><td><a href="tools.md">tools.md</a></td><td></td></tr><tr><td><strong>🪪 Authentication</strong></td><td>How JWT and on-chain scope verification work together.</td><td><a href="mcp-authentication.md">mcp-authentication.md</a></td><td></td></tr></tbody></table>
