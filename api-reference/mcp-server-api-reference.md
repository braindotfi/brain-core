# MCP Server (API Reference)

The MCP server is exposed at `POST /v1/agents/mcp`, JSON-RPC 2.0 over single-shot HTTP. This page is the API-style summary; for the full reference (tool list, resources, prompts, on-chain auth flow), see the dedicated MCP Server section.

### Endpoint

```
POST /v1/agents/mcp
Authorization: Bearer <jwt>
Content-Type: application/json
```

There is **no separate MCP hostname** — the surface is a JSON-RPC endpoint on the same API host.

| Environment    | URL                                          |
| -------------- | -------------------------------------------- |
| **Production** | `https://api.brain.fi/v1/agents/mcp`         |
| **Sandbox**    | `https://api.sandbox.brain.fi/v1/agents/mcp` |

Sandbox is wired to Base Sepolia; production is wired to Base mainnet.

### Methods

The methods the JSON-RPC entry accepts (matches the spec's `JsonRpcRequest.method` enum):

| Method           | Purpose                                                    |
| ---------------- | ---------------------------------------------------------- |
| `initialize`     | Capability negotiation                                     |
| `ping`           | Liveness                                                   |
| `tools/list`     | List tools the agent has scope for                         |
| `tools/call`     | Invoke a tool                                              |
| `resources/list` | List resources (and resource templates) the agent can read |
| `resources/read` | Read a resource by URI                                     |
| `prompts/list`   | List the canned prompts                                    |
| `prompts/get`    | Render a canned prompt with arguments                      |

The HTTP layer always returns `200`; application errors live in the JSON-RPC response's `error` field.

### The 10 Tools

Five Ledger reads, two Wiki reads, one Raw contribute, one PaymentIntent propose, one agent action propose. **There is no `payment_intent.execute` tool, and there will never be one** — execution is reserved for internal Brain workers running under tenant policy and the §6 gate.

[**→ Tool reference**](../mcp-server/tools.md)

### The 5 Resource Templates

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

JWT (Fastify JWT plugin) plus three pre-call checks before any method dispatches:

1. The agent record is **active** in `BrainMCPAgentRegistry`.
2. The JWT's `scope_hash` claim matches the agent's on-chain `scopeHash` (60-second cache, Base RPC fallback).
3. The JWT's `tenantId` claim equals the agent's registered `tenantId`.

Per-tool scope (e.g. `payment_intent:propose`) is enforced at invocation time.

[**→ Authentication reference**](../mcp-server/mcp-authentication.md)

### Error Codes

Brain-specific JSON-RPC error codes (`-32001..-32005`) and the standard JSON-RPC codes:

| Code     | Meaning                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------- |
| `-32001` | Auth token missing, invalid, or expired (`auth_token_missing/invalid/expired`)                 |
| `-32002` | Scope insufficient (also tenant mismatch) (`auth_scope_insufficient` / `auth_tenant_mismatch`) |
| `-32003` | Agent not registered or inactive (`agent_not_registered`)                                      |
| `-32004` | Pre-execution gate failed — covers every `gate_*` sub-code (`payment_intent_gate_failed`)      |
| `-32005` | Agent `scope_hash` mismatch against on-chain registration (`agent_scope_hash_mismatch`)        |
| `-32600` | Invalid request (standard JSON-RPC)                                                            |
| `-32601` | Method not found                                                                               |
| `-32602` | Invalid params                                                                                 |
| `-32603` | Internal error                                                                                 |
| `-32700` | Parse error                                                                                    |

The mapping is enforced in `services/mcp/src/types.ts` and `dispatcher.ts` — every Brain HTTP error code routes deterministically into one of these five Brain-specific JSON-RPC codes.

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
      "question":  "What's our cash position right now?"
    }
  }
}
```

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔌 MCP Overview</strong></td><td>The full architecture and surface map.</td><td><a href="../mcp-server/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>🛠️ Tools</strong></td><td>The 10 tools in detail.</td><td><a href="../mcp-server/tools.md">tools.md</a></td><td></td></tr><tr><td><strong>🪪 Authentication</strong></td><td>JWT and on-chain scope verification.</td><td><a href="../mcp-server/mcp-authentication.md">mcp-authentication.md</a></td><td></td></tr></tbody></table>
