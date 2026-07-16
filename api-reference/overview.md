# Overview

Brain exposes a **REST + JSON-RPC HTTP surface** and an **MCP server surface**. The same primitives are used by humans and agents. Only authentication differs.

### Base URLs

| Environment    | URL                               |
| -------------- | --------------------------------- |
| **Production** | `https://api.brain.fi/v1`         |
| **Sandbox**    | `https://staging-api.brain.fi/v1` |

### Authentication

| Caller     | Mechanism                                              |
| ---------- | ------------------------------------------------------ |
| **Humans** | Self-serve email + password, or a linked wallet (SIWX) |
| **Agents** | SIWX (EIP-4361 over Base) + EIP-712 ScopeAttestations  |

[**Authentication reference**](authentication.md)

### Representative Endpoints

```
POST   /v1/raw/ingest                       // ingest a Raw artifact
GET    /v1/ledger/transactions              // query structured Ledger records
POST   /v1/wiki/question                    // NL query over memory
POST   /v1/policy/{tenant_id}/compose       // compose a candidate policy
POST   /v1/policy/{tenant_id}/sign          // sign + activate
POST   /v1/execution/agents/register        // register an external agent
POST   /v1/agents/run                       // route -> resolve -> propose (gated)
POST   /v1/payment-intents                  // propose a payment
POST   /v1/payment-intents/{id}/approve     // approver signs
POST   /v1/payment-intents/{id}/execute     // run §6 gate; returns 202
GET    /v1/audit/event/{event_id}           // event + Merkle inclusion proof
GET    /v1/proof/{action_id}                // canonical Proof for an action
DELETE /v1/tenants/{id}                     // GDPR right-to-erasure (self-tenant only)
```

### Endpoint Reference

| Section                   | What's Covered                                                            |
| ------------------------- | ------------------------------------------------------------------------- |
| Authentication            | Email + password, SIWX, sessions, scopes                                  |
| Sources and Raw Ingestion | Ingest artifacts directly, provider webhooks, inspect and tombstone       |
| Ledger                    | Query transactions, balances, counterparties, invoices, reconcile         |
| Wiki                      | NL questions, entity browsing, evidence chains, memory pages              |
| Policy                    | Compose, sign, evaluate, lint, simulate, diff (tenant-scoped)             |
| Agents                    | Register, list catalog, route, run, halt, runs / why / gate-trace / proof |
| Actions (Payment Intents) | Propose, approve / reject, execute (runs §6 gate), pause / resume         |
| Audit                     | Events, entity history, Merkle proofs, verify, export, Proof artifact     |
| MCP Surface               | JSON-RPC tools, resources, prompts, on-chain scope check                  |

### Provenance on Every Response

Every response from Wiki, Policy, and Agent endpoints carries provenance.

| Field                | Description                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `source_ids`         | Raw artifact ids that produced a Ledger row                                  |
| `evidence_ids`       | Raw-parsed row ids the extractor consulted                                   |
| `evidence_path`      | Returned by Wiki answers: the chain of Raw / Ledger refs the answer rests on |
| `provenance`         | `extracted`, `inferred`, `ambiguous`, `human_confirmed`, `agent_contributed` |
| `confidence`         | Calibrated 0–1 score on every derived row                                    |
| `policy_decision_id` | Policy decision row joined to a PaymentIntent                                |

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
    "docs_url": "https://docs.brain.fi/resources/errors#policy_denied"
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

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Authentication</strong></td><td>Email, wallet, and SIWX in detail.</td><td><a href="authentication.md">authentication.md</a></td><td></td></tr><tr><td><strong>MCP Surface</strong></td><td>Same primitives, MCP shape.</td><td><a href="../mcp-server/overview.md">overview.md</a></td><td></td></tr></tbody></table>
