# Overview

Brain exposes a **REST + JSON-RPC HTTP surface** and an **MCP server surface**. The same primitives are used by humans and agents. Only authentication differs.

### Base URLs

| Environment    | URL                            |
| -------------- | ------------------------------ |
| **Production** | `https://api.brain.fi`         |
| **Sandbox**    | `https://api.brain.fi/sandbox` |

### Authentication

| Caller     | Mechanism                                              |
| ---------- | ------------------------------------------------------ |
| **Humans** | Self-serve email + password, or a linked wallet (SIWX) |
| **Agents** | SIWX (EIP-4361 over Base) + EIP-712 ScopeAttestations  |

[**→ Authentication reference**](authentication.md)

### Representative Endpoints

```
POST   /v1/sources                  // connect a financial source
POST   /v1/raw/ingest               // submit raw artifacts directly
GET    /v1/ledger/transactions      // structured records
POST   /v1/wiki/question            // NL query over memory
POST   /v1/policy                   // create or update a policy
POST   /v1/agents                   // register an external agent
POST   /v1/agents/{id}/propose      // propose an action
POST   /v1/actions/{id}/approve     // human approval
POST   /v1/actions/{id}/execute     // execute approved action
GET    /v1/audit/{id}               // audit trail with Merkle proof
```

### Endpoint Reference

| Section                   | What's Covered                                         |
| ------------------------- | ------------------------------------------------------ |
| Authentication            | OAuth, SIWX, sessions, scopes                          |
| Sources and Raw Ingestion | Connect Plaid, banks, ERPs, wallets, files             |
| Ledger                    | Query transactions, balances, counterparties, invoices |
| Wiki                      | NL questions, entity browsing, semantic search         |
| Policy                    | Create, sign, simulate, evaluate, revoke               |
| Agents                    | Register, scope, list                                  |
| Actions                   | Propose, approve, execute                              |
| Audit                     | Events, Merkle proofs, exports                         |
| MCP Surface               | Tool list, namespacing, MCP-specific patterns          |

### Provenance on Every Response

Every response from Wiki, Policy, and Agent endpoints carries provenance.

| Field            | Description                                   |
| ---------------- | --------------------------------------------- |
| `ledger_refs`    | Ledger record IDs the answer depends on       |
| `raw_refs`       | Raw artifact hashes those records derive from |
| `policy_version` | Policy version evaluated, if any              |
| `audit_event_id` | Event ID under which the call was logged      |

### Versioning

The API is versioned in the URL path: `/v1/...`. Breaking changes always bump the version. Non-breaking additions (new endpoints, new fields) ship in place.

| Behaviour                             | Considered Breaking? |
| ------------------------------------- | -------------------- |
| Adding an endpoint                    | No                   |
| Adding a field to a response          | No                   |
| Adding an optional field to a request | No                   |
| Removing or renaming a field          | Yes                  |
| Changing default behaviour            | Yes                  |
| Changing an HTTP status code          | Yes                  |

### Rate Limits

Rate limits apply per API key.

| Tier           | Requests / min | Burst  | Concurrent WebSockets |
| -------------- | -------------- | ------ | --------------------- |
| **Free**       | 60             | 100    | 5                     |
| **Developer**  | 600            | 1,000  | 25                    |
| **Production** | 6,000          | 10,000 | 250                   |
| **Enterprise** | Custom         | Custom | Custom                |

When rate-limited:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1700000000
```

{% hint style="warning" %}
Always honour the `Retry-After` header. Aggressive retries against rate limits will result in temporary key suspension.
{% endhint %}

### Errors

All errors share a common shape.

```json
{
  "error": {
    "code": "policy_denied",
    "message": "Counterparty not approved",
    "details": { "counterparty_id": "cp_x", "policy_version": 3 },
    "request_id": "req_8f3a92...",
    "docs_url": "https://docs.brain.fi/errors/policy_denied"
  }
}
```

| Status | Meaning                                     |
| ------ | ------------------------------------------- |
| `400`  | Validation error                            |
| `401`  | Authentication failed                       |
| `403`  | Authenticated, but lacks scope              |
| `404`  | Not found                                   |
| `409`  | Conflict (e.g. duplicate registration)      |
| `422`  | Policy denied or escalation required        |
| `429`  | Rate limit exceeded                         |
| `500`  | Internal error (always logs a `request_id`) |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🪪 Authentication</strong></td><td>OAuth and SIWX in detail.</td><td><a href="authentication.md">authentication.md</a></td><td></td></tr><tr><td><strong>🌐 MCP Surface</strong></td><td>Same primitives, MCP shape.</td><td><a href="../mcp-server/overview.md">overview.md</a></td><td></td></tr></tbody></table>
