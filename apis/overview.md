# Overview

Brain exposes a **REST + JSON-RPC HTTP surface** and an **MCP server surface**. The same primitives are used by humans and agents. Only authentication differs.

### Base URLs

<table><thead><tr><th width="250">Environment</th><th>URL</th></tr></thead><tbody><tr><td><strong>Production</strong></td><td><code>https://api.brain.fi</code></td></tr><tr><td><strong>Sandbox</strong></td><td><code>https://api.brain.fi/sandbox</code></td></tr></tbody></table>

### Authentication

<table><thead><tr><th width="250">Caller</th><th>Mechanism</th></tr></thead><tbody><tr><td><strong>Humans</strong></td><td>OAuth / SSO (Auth0)</td></tr><tr><td><strong>Agents</strong></td><td>SIWX (EIP-4361 over Base) + EIP-712 ScopeAttestations</td></tr></tbody></table>

**→ Authentication reference**

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

<table><thead><tr><th width="250">Section</th><th>What's Covered</th></tr></thead><tbody><tr><td>Authentication</td><td>OAuth, SIWX, sessions, scopes</td></tr><tr><td>Sources and Raw Ingestion</td><td>Connect Plaid, banks, ERPs, wallets, files</td></tr><tr><td>Ledger</td><td>Query transactions, balances, counterparties, invoices</td></tr><tr><td>Wiki</td><td>NL questions, entity browsing, semantic search</td></tr><tr><td>Policy</td><td>Create, sign, simulate, evaluate, revoke</td></tr><tr><td>Agents</td><td>Register, scope, list</td></tr><tr><td>Actions</td><td>Propose, approve, execute</td></tr><tr><td>Audit</td><td>Events, Merkle proofs, exports</td></tr><tr><td>MCP Surface</td><td>Tool list, namespacing, MCP-specific patterns</td></tr></tbody></table>

### Provenance on Every Response

Every response from Wiki, Policy, and Agent endpoints carries provenance.

<table><thead><tr><th width="250">Field</th><th>Description</th></tr></thead><tbody><tr><td><code>ledger_refs</code></td><td>Ledger record IDs the answer depends on</td></tr><tr><td><code>raw_refs</code></td><td>Raw artifact hashes those records derive from</td></tr><tr><td><code>policy_version</code></td><td>Policy version evaluated, if any</td></tr><tr><td><code>audit_event_id</code></td><td>Event ID under which the call was logged</td></tr></tbody></table>

### Versioning

The API is versioned in the URL path: `/v1/...`. Breaking changes always bump the version. Non-breaking additions (new endpoints, new fields) ship in place.

<table><thead><tr><th width="350">Behaviour</th><th>Considered Breaking?</th></tr></thead><tbody><tr><td>Adding an endpoint</td><td>No</td></tr><tr><td>Adding a field to a response</td><td>No</td></tr><tr><td>Adding an optional field to a request</td><td>No</td></tr><tr><td>Removing or renaming a field</td><td>Yes</td></tr><tr><td>Changing default behaviour</td><td>Yes</td></tr><tr><td>Changing an HTTP status code</td><td>Yes</td></tr></tbody></table>

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
    "code":     "policy.denied",
    "message":  "Counterparty not approved",
    "details":  { "counterparty_id": "cp_x", "policy_version": 3 },
    "trace_id": "trc_8f3a92..."
  }
}
```

<table><thead><tr><th width="150">Status</th><th>Meaning</th></tr></thead><tbody><tr><td><code>400</code></td><td>Validation error</td></tr><tr><td><code>401</code></td><td>Authentication failed</td></tr><tr><td><code>403</code></td><td>Authenticated, but lacks scope</td></tr><tr><td><code>404</code></td><td>Not found</td></tr><tr><td><code>409</code></td><td>Conflict (e.g. duplicate registration)</td></tr><tr><td><code>422</code></td><td>Policy denied or escalation required</td></tr><tr><td><code>429</code></td><td>Rate limit exceeded</td></tr><tr><td><code>500</code></td><td>Internal error (always logs a <code>trace_id</code>)</td></tr></tbody></table>
