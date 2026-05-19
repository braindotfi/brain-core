# Resources

Brain's MCP server exposes **5 resource templates** that let agents address Brain entities by URI. Resources complement tools: where tools are verbs (`tools/call`), resources are nouns (`resources/read`).

| Property           | Value                            |
| ------------------ | -------------------------------- |
| **URI scheme**     | `brain://`                       |
| **MCP method**     | `resources/read`                 |
| **Required scope** | Same as the equivalent read tool |

### The 5 templates

| Resource               | URI Pattern                                          | Required Scope                          |
| ---------------------- | ---------------------------------------------------- | --------------------------------------- |
| **Ledger account**     | `brain://ledger/accounts/{account_id}`               | `ledger:read`                           |
| **Ledger transaction** | `brain://ledger/transactions/{transaction_id}`       | `ledger:read`                           |
| **Payment intent**     | `brain://ledger/payment-intents/{payment_intent_id}` | `ledger:read`                           |
| **Wiki page**          | `brain://wiki/{slug}`                                | `wiki:read`                             |
| **Raw evidence**       | `brain://raw/{raw_artifact_id}`                      | `ledger:read` _(via parsed projection)_ |

### Why resources

Tools are good for queries with arguments. Resources are good for entities with stable identifiers that an agent already knows about: a transaction id from a recent `ledger.transactions.list` response, a payment intent id from a previous propose, a wiki page slug like `/monthly-summaries/2025-09`.

Treating them as resources rather than tool calls has three benefits:

| Benefit              | Detail                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Cacheable**        | An MCP runtime can cache resource reads by URI without understanding the tool's argument shape       |
| **Context-friendly** | Agents can pass URIs back and forth in their planning context without re-fetching                    |
| **Discoverable**     | `resources/list` enumerates what's reachable; `resources/templates/list` advertises the URI patterns |

### Reading a resource

```http
POST /v1/agents/mcp HTTP/1.1
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "resources/read",
  "params": {
    "uri": "brain://ledger/transactions/tx_4127"
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "contents": [
      {
        "uri": "brain://ledger/transactions/tx_4127",
        "mimeType": "application/json",
        "text": "{ \"id\": \"tx_4127\", \"amount\": \"61404.12\", \"currency\": \"USD\", ... }"
      }
    ]
  }
}
```

### URI examples

```
brain://ledger/accounts/acct_8231
brain://ledger/transactions/tx_4127
brain://ledger/payment-intents/pi_a1b2c3
brain://wiki/monthly-summaries/2025-09
brain://wiki/counterparties/cp_aws
brain://raw/raw_01HW3X9...
```

{% hint style="info" %}
The Wiki URI uses the page slug, not the page id. Slugs are stable across regenerations; ids change when a page is regenerated. For agent context that needs to survive regeneration, use the slug.
{% endhint %}

### Resource discovery

Two methods support discovery.

#### `resources/list`

Lists concrete resources the agent currently has scope to read. For Ledger accounts, this might return one entry per account. For Wiki, one entry per existing page. For Raw, only the raw artifacts the agent itself contributed (others are hidden by scope).

#### `resources/templates/list`

Lists the URI patterns Brain advertises:

```json
{
  "resourceTemplates": [
    {
      "uriTemplate": "brain://ledger/accounts/{account_id}",
      "name": "Ledger account",
      "description": "A bank account, card, loan, or on-chain address.",
      "mimeType": "application/json"
    },
    {
      "uriTemplate": "brain://ledger/transactions/{transaction_id}",
      "name": "Ledger transaction",
      "description": "A single money-movement event.",
      "mimeType": "application/json"
    },
    { "uriTemplate": "brain://ledger/payment-intents/{payment_intent_id}", "name": "Payment intent", "description": "An agent-proposed financial action.", "mimeType": "application/json" },
    { "uriTemplate": "brain://wiki/{slug}", "name": "Wiki page", "description": "Human-readable financial memory page.", "mimeType": "text/markdown" },
    { "uriTemplate": "brain://raw/{raw_artifact_id}", "name": "Raw evidence", "description": "Source evidence (immutable).", "mimeType": "application/json" }
  ]
}
```

### What resources are not

| Not a Resource                 | Why                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Lists, queries, search results | Tools handle those (`*.list`)                                                |
| Newly proposed entities        | The propose tool is the canonical entry point; resources are for fetch-by-id |
| Streaming feeds                | Single-shot HTTP only in MVP                                                 |

### Audit

Every successful `resources/read` emits an `agent.mcp.tool_called` audit event with `method: "resources/read"` and the URI in `inputs`. This means a tenant can see exactly which agent fetched which entity at which time, just like for tool calls.

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛠️ Tools</strong></td><td>The 10 tools at the heart of the MCP surface.</td><td><a href="tools.md">tools.md</a></td><td></td></tr><tr><td><strong>💬 Prompts</strong></td><td>Canned prompts for common agent loops.</td><td><a href="prompts.md">prompts.md</a></td><td></td></tr></tbody></table>
