# MCP Server (API Reference)

The MCP server is exposed at `POST /v1/agents/mcp`, JSON-RPC 2.0 over single-shot HTTP. This page is the API-style summary; for the full reference (tool list, resources, prompts, error codes, on-chain auth flow), see the dedicated MCP Server section.

### Endpoint

```
POST /v1/agents/mcp
Authorization: Bearer <jwt>
Content-Type: application/json
```

### Sandbox

```
POST /v1/agents/mcp        on api.brain.dev   → Base Sepolia
POST /v1/agents/mcp        on api.brain.fi    → Base mainnet
```

### Methods

Standard MCP JSON-RPC methods:

| Method                     | Purpose                                    |
| -------------------------- | ------------------------------------------ |
| `initialize`               | Capability negotiation                     |
| `tools/list`               | List tools the agent has scope for         |
| `tools/call`               | Invoke a tool                              |
| `resources/list`           | List concrete resources the agent can read |
| `resources/templates/list` | List the 5 URI templates Brain advertises  |
| `resources/read`           | Read a resource by URI                     |
| `prompts/list`             | List the 5 canned prompts                  |
| `prompts/get`              | Render a canned prompt with arguments      |

### The 10 Tools

Five Ledger reads, two Wiki reads, one Raw contribute, one PaymentIntent propose, one agent action propose. **No `payment_intent.execute`.**

[**→ Tool reference**](../mcp-server/tools.md)

### The 5 Resources

Resource templates addressable by `brain://` URIs:

```
brain://ledger/accounts/{account_id}
brain://ledger/transactions/{transaction_id}
brain://ledger/payment-intents/{payment_intent_id}
brain://wiki/{slug}
brain://raw/{raw_artifact_id}
```

[**→ Resources reference**](../mcp-server/resources.md)

### The 5 Prompts

`cash_flow_summary`, `bills_due`, `spending_change`, `invoice_status`, `subscriptions`.

[**→ Prompts reference**](../mcp-server/prompts.md)

### Authentication

JWT plus on-chain `scope_hash` verification against `BrainMCPAgentRegistry`. Three pre-call checks run before any method dispatches; per-tool scope is checked at invocation.

[**→ Authentication reference**](../mcp-server/mcp-authentication.md)

### Error Codes

| Code     | Meaning                                   |
| -------- | ----------------------------------------- |
| `-32001` | JWT invalid or expired                    |
| `-32002` | Agent record not active                   |
| `-32003` | `scope_hash` does not match on-chain hash |
| `-32004` | Per-call scope insufficient               |
| `-32005` | Tenant mismatch                           |
| `-32600` | Invalid request (standard JSON-RPC)       |
| `-32601` | Method not found                          |
| `-32602` | Invalid params                            |
| `-32603` | Internal error                            |

### A First Call

```http
POST /v1/agents/mcp HTTP/1.1
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
      "question": "What's our cash position right now?"
    }
  }
}
```

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔌 MCP overview</strong></td><td>The full architecture and surface map.</td><td><a href="../mcp-server/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>🛠️ Tools</strong></td><td>The 10 tools in detail.</td><td><a href="../mcp-server/tools.md">tools.md</a></td><td></td></tr><tr><td><strong>🪪 Authentication</strong></td><td>JWT and on-chain scope verification.</td><td><a href="../mcp-server/mcp-authentication.md">mcp-authentication.md</a></td><td></td></tr></tbody></table>
