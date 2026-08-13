# MCP Server (API Reference)

The MCP server is reachable at the canonical host `https://mcp.brain.fi` (which maps root traffic onto the internal `POST /v1/agents/mcp` route), JSON-RPC 2.0 over single-shot HTTP. This page is the API-style summary; for the full reference (tool list, resources, prompts, on-chain auth flow), see the dedicated MCP Server section.

### Endpoint

```
POST /
Host: mcp.brain.fi
Authorization: Bearer <jwt>
Content-Type: application/json
```

The canonical public host is **`mcp.brain.fi`**, which maps root traffic onto the internal `/v1/agents/mcp` route.

{% hint style="warning" %}
There is no separate sandbox host. `mcp.brain.dev` and a Base-mainnet production distinction are aspirational: the on-chain scope checker (`services/api/src/mcp/viemScopeChecker.ts`) is hardcoded to Base Sepolia regardless of environment, and there is no code path that switches it to Base mainnet. Do not point integrations at `mcp.brain.dev`; it is not live.
{% endhint %}

### Methods

The methods the JSON-RPC entry accepts (matches the spec's `JsonRpcRequest.method` enum):

| Method                     | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `initialize`               | Capability negotiation                               |
| `ping`                     | Liveness                                             |
| `tools/list`               | List tools (the full registry, not scope-filtered)   |
| `tools/call`               | Invoke a tool                                        |
| `resources/list`           | List the concrete (non-templated) readable resources |
| `resources/templates/list` | List the templated resources                         |
| `resources/read`           | Read a resource by URI                               |
| `prompts/list`             | List the canned prompts                              |
| `prompts/get`              | Render a canned prompt with arguments                |

A request with no `id` member is a JSON-RPC notification (e.g. the mandatory `notifications/initialized` handshake message); it gets no response at all, not even an empty JSON-RPC envelope -- the HTTP layer answers `202 Accepted` with an empty body.

Once a request reaches JSON-RPC dispatch, the HTTP layer returns `200` and application errors live in the JSON-RPC response's `error` field. **Authentication and authorization fail _before_ dispatch**, so they return an HTTP `401`/`403` Brain error envelope (not a `200` with a JSON-RPC `error`). See [Error Codes](#error-codes).

### The 17 Tools

Five Ledger reads, two Wiki reads, one Raw contribute, one Raw artifact read, three PaymentIntent tools (`payment_intent.propose`, `payment_intent.cancel`, `payment_intent.list`), three proposal tools (`proposals.list`, `proposals.get`, `proposals.decide`), one evidence resolve (`evidence.resolve`), and one agent action propose. **There is no `payment_intent.execute` tool, and there will never be one**. Execution is reserved for internal Brain workers running under tenant policy and the §6 gate.

`tools/list` returns the full registry regardless of the caller's granted scopes -- a tool the agent is not scoped for is still listed; only `tools/call` enforces the per-tool scope gate.

None of the 17 tools accept a `tenant_id` argument. The tenant is always derived from the JWT.

[**→ Tool reference**](../mcp-server/tools.md)

### 1 Concrete Resource, 6 Resource Templates

The one genuinely readable resource, returned by `resources/list`:

```
brain://payments/action_types
```

The six templated resources, returned only by `resources/templates/list` (each has a `{...}` placeholder that must be substituted with a real id before it can be read):

```
brain://ledger/accounts/{account_id}
brain://ledger/transactions/{transaction_id}
brain://ledger/obligations/{obligation_id}
brain://ledger/payment-intents/{payment_intent_id}
brain://wiki/pages/{slug}
brain://proofs/{action_id}
```

[**→ Resources reference**](../mcp-server/resources.md)

### The 5 Prompts

`wiki.question.cash_flow_summary`, `wiki.question.bills_due`, `wiki.question.spending_change`, `wiki.question.invoice_status`, `wiki.question.subscriptions`.

[**→ Prompts reference**](../mcp-server/prompts.md)

### Authentication

A JWT issued by `auth.brain.fi` and verified via its published JWKS, plus checks the MCP auth verifier (`services/mcp/src/auth.ts`) runs before any method dispatches:

1. The agent record in the `agents` table is **active**.
2. The JWT's `tenant_id` equals that DB row's `tenant_id`.
3. The agent is registered and not revoked in `BrainMCPAgentRegistry`.
4. The DB row's `scope_hash` matches the on-chain `scopeHash` (60-second cache, Base Sepolia RPC).

There is no `scope_hash` claim on the JWT itself; the scope-hash comparison above is entirely server-side, between the DB column and the on-chain value.

Per-tool scope (e.g. `payment_intent:propose`) is enforced at invocation time.

[**→ Authentication reference**](../mcp-server/mcp-authentication.md)

### Error Codes

There are **two error surfaces**, depending on where the request fails:

- **Pre-dispatch auth failures**. The route guard (`services/mcp/src/transport/http.ts`) checks the JWT/principal type, then the auth verifier (`services/mcp/src/auth.ts`, invoked at the top of `server.handle`) checks on-chain registration, scope-hash, and tenant **before** any method is dispatched. These throw `BrainError`s that propagate out of the handler, so the client receives an HTTP `401`/`403` **Brain error envelope** -- `{ "error": { "code": ..., "message": ..., "details": ..., "request_id": ..., "docs_url": ... } }` per Brain Engineering Standards §4.1 -- _not_ a JSON-RPC response. The relevant codes: `auth_token_missing`, `auth_token_invalid`, `auth_token_expired`, `auth_scope_insufficient`, `auth_tenant_mismatch`, `agent_not_registered`, `agent_not_registered_onchain`, `agent_scope_hash_missing`, `agent_scope_hash_mismatch`.
- **Post-auth JSON-RPC errors**. Once dispatch begins, the HTTP status is `200` and the failure is carried in the JSON-RPC `error` field using the Brain-specific codes below (`-32001..-32005`) plus the standard JSON-RPC codes.

| Code     | Meaning                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-32001` | Auth token missing, invalid, or expired (`auth_token_missing/invalid/expired`)                                                                                                                          |
| `-32002` | Scope insufficient (also tenant mismatch) (`auth_scope_insufficient` / `auth_tenant_mismatch`)                                                                                                          |
| `-32003` | Agent not registered or inactive (`agent_not_registered`, `agent_not_registered_onchain`)                                                                                                               |
| `-32004` | Pre-execution gate failed. Covers every `gate_*` sub-code (`payment_intent_gate_failed`)                                                                                                                |
| `-32005` | Agent `scope_hash` mismatch against on-chain registration (`agent_scope_hash_mismatch`)                                                                                                                 |
| `-32600` | Invalid request (standard JSON-RPC)                                                                                                                                                                     |
| `-32601` | Method not found                                                                                                                                                                                        |
| `-32602` | Invalid params, including the not-found family (`ledger_row_not_found`, `payment_intent_not_found`, `wiki_page_not_found`, etc.), `payment_intent_invalid_state`, and `payment_intent_approval_invalid` |
| `-32603` | Internal error                                                                                                                                                                                          |
| `-32700` | Parse error                                                                                                                                                                                             |

The mapping is enforced in `services/mcp/src/dispatcher.ts`. Every Brain HTTP error code that surfaces _inside_ JSON-RPC dispatch routes deterministically into one of these Brain-specific JSON-RPC codes. (The `-3200x` codes above only apply once a call has authenticated; pre-dispatch auth failures use the HTTP envelope described above.)

### A First Call

```http
POST / HTTP/1.1
Host: mcp.brain.fi
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "wiki.question",
    "arguments": {
      "question":  "What's our cash position right now?"
    }
  }
}
```

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔌 MCP Overview</strong></td><td>The full architecture and surface map.</td><td><a href="../mcp-server/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>🛠️ Tools</strong></td><td>The 17 tools in detail.</td><td><a href="../mcp-server/tools.md">tools.md</a></td><td></td></tr><tr><td><strong>🪪 Authentication</strong></td><td>JWT and on-chain scope verification.</td><td><a href="../mcp-server/mcp-authentication.md">mcp-authentication.md</a></td><td></td></tr></tbody></table>
