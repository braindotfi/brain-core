# Audit API

Query audit events, pull a Merkle inclusion proof, verify a proof independently, walk the full history for any Ledger entity, export, and pull the canonical **Proof** for an action. All event payloads land in the append-only hash chain. Production tenant roots are batch-anchored to `BrainAuditAnchor` on Base Sepolia; demo and sandbox tenants remain database-hash-chain-only and are not published on-chain.

The publisher closes a production batch after 50 eligible tenant roots or one
hour of waiting, whichever comes first. These are configurable operational
limits. Database-linked Base Sepolia production receipts measured on 2026-08-11
across 36 transactions and 189 roots ranged from 47,325 to 73,620 gas per tenant
root, with a weighted average of 51,474. This is an observed measurement, not a
fixed gas or cost guarantee. It does not represent a full publisher-wallet cost
guarantee while wallet-to-anchor reconciliation remains under investigation.

| Operation                           | Endpoint                                             |
| ----------------------------------- | ---------------------------------------------------- |
| Get the latest anchor               | `GET  /v1/audit/anchor/latest`                       |
| Walk an entity's history            | `GET  /v1/audit/entity/{entityType}/{entityId}`      |
| Get one event (+ inclusion proof)   | `GET  /v1/audit/event/{event_id}`                    |
| Query events                        | `GET  /v1/audit/events`                              |
| Publish an on-demand tenant anchor  | `POST /v1/audit/anchor/publish`                      |
| Manage outbound webhook endpoints   | `POST`, `GET`, `DELETE /v1/audit/webhooks/endpoints` |
| Export (not implemented, see below) | `POST /v1/audit/export`                              |
| Independent verification            | `POST /v1/audit/verify`                              |
| Canonical Proof for an action       | See the [Proof API](proof-api.md)                    |

### Get the Latest Anchor

```http
GET /v1/audit/anchor/latest
Authorization: Bearer <token>
```

```json
{
  "anchoring_mode": "onchain",
  "guarantee": "base_sepolia",
  "merkle_root": "0xabc...",
  "event_count": 4127,
  "period_start": "2026-05-28T11:00:00Z",
  "period_end": "2026-05-28T11:30:00Z",
  "onchain_tx_hash": "0xdef...",
  "onchain_block_number": 8829110
}
```

For a demo or sandbox tenant, this endpoint returns `200` with
`"anchoring_mode": "db_only"` and `"guarantee": "database_hash_chain"`.
Its anchor fields are `null`: the tenant keeps an append-only database hash
chain, but no root is submitted to Base Sepolia.

### Walk an Entity's History

Every audit event that touched a specific Ledger row, in causal order.

```http
GET /v1/audit/entity/{entityType}/{entityId}
Authorization: Bearer <token>
```

`entityType` is one of `account | balance | transaction | counterparty | obligation | document | invoice | payment_intent | reconciliation_match | proposal | execution`.

```json
{
  "entity_type": "payment_intent",
  "entity_id": "pi_a1b2c3",
  "events": [
    {
      "id": "audit_evt_001",
      "layer": "agent",
      "event_type": "payment_intent.created",
      "category": "payment_intent.created",
      "severity": "info",
      "actor": "ag_payment_v1",
      "actor_ref": {
        "id": "ag_payment_v1",
        "type": "agent",
        "display_name": "Payment Agent",
        "email": null,
        "lookup": "/v1/execution/agents/ag_payment_v1"
      },
      "action": "payment_intent.proposed",
      "inputs": { "evidence_ids": ["rp_001"], "policy_version": 4 },
      "outputs": { "payment_intent_id": "pi_a1b2c3" },
      "policy_version": 4,
      "policy_decision_id": "pd_7331",
      "policy_check_id": "rule_invoice_above_5k",
      "outcome": "confirm",
      "event_hash": "0x...",
      "prev_event_hash": "0x...",
      "created_at": "2026-05-28T12:00:00Z"
    }
  ]
}
```

`inputs` and `outputs` carry **hashes and evidence references only**. Never raw payloads or PII. The full encrypted payload stays off-chain.

### Get One Event with Inclusion Proof

```http
GET /v1/audit/event/{event_id}
Authorization: Bearer <token>
```

```json
{
  "event": { "id": "audit_evt_001", ... },
  "inclusion_proof": {
    "merkle_root":     "0xabc...",
    "merkle_proof":    ["0x111...", "0x222..."],
    "anchor_tx_hash":  "0xdef...",
    "anchor_block":    8829110
  }
}
```

### Query Events

```http
GET /v1/audit/events?layer=agent
Authorization: Bearer <token>
```

Filters: `layer` (`raw | ledger | wiki | policy | agent | execution | audit`), `actor`, `since`, `until`, `limit` (default 100, max 1000), `cursor`. Returns `{ events: AuditEvent[], next_cursor }`.

### Publish an Anchor

`POST /v1/audit/anchor/publish` publishes the calling tenant's next eligible
audit window on Base Sepolia. It requires `audit:admin` and enforces a durable
per-tenant 60-second cooldown. Database-only tenants receive `409`
`audit_anchor_db_only`; a tenant with no unanchored events receives
`audit_no_events`.

### Manage Outbound Webhook Endpoints

Register an HTTPS receiver with `audit:write`:

```http
POST /v1/audit/webhooks/endpoints
Authorization: Bearer <token with audit:write>
Content-Type: application/json

{ "url": "https://receiver.example.test/events", "enabled_events": ["payment_intent.executed"] }
```

The `201` response returns the endpoint secret once. List endpoints with
`GET /v1/audit/webhooks/endpoints` and `audit:read`; returned secrets are masked
as `secret_preview`. Delete an endpoint with
`DELETE /v1/audit/webhooks/endpoints/{id}` and `audit:write`, which returns `204`.

### Independent Verification

A counterparty (or an auditor) verifies an event without trusting Brain: supply the event hash, the Merkle proof, and the claimed root. The endpoint runs the path computation and returns whether it lands on the supplied root.

```http
POST /v1/audit/verify
Content-Type: application/json

{
  "event_hash":   "0x...",
  "merkle_proof": ["0x111...", "0x222..."],
  "merkle_root":  "0xabc..."
}
```

```json
{ "verified": true, "onchain_block": 8829110 }
```

Brain also publishes a `verifyMerkleProof(...)` helper in `@brainfinance/sdk`
and the on-chain `BrainAuditAnchor.verifyInclusion(root, leaf, proof)` view
function. Check `isPublished(tenantId, root)` to verify the root belongs to the
tenant. Three independent paths reach the same conclusion.

### Export

`POST /v1/audit/export` is a declared stub. It validates the request shape and
then always returns `501` (error code `dependency_unavailable`) -- there is
no job row, worker, or status/download route behind it. Use the working
tenant export instead:

```http
POST /v1/tenants/{tenant_id}/export
Authorization: Bearer <token>
```

Poll `GET /v1/tenants/{tenant_id}/export/{job_id}` for status and fetch the
result from `GET /v1/tenants/{tenant_id}/export/{job_id}/download` once ready.

### The Canonical Proof for an Action

For investor / compliance / counterparty use cases, the flagship artifact is the per-action **Proof**. Assembled from the §6 gate trace, evidence chain, policy decision, and anchored audit Merkle chain. It has its own page so this one can stay focused on raw events and anchors.

[**Proof API**](proof-api.md)

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Proof API</strong></td><td>The per-action trust artifact.</td><td><a href="proof-api.md">proof-api.md</a></td><td></td></tr><tr><td><strong>Audit Concepts</strong></td><td>How the hash chain and Merkle anchoring work.</td><td><a href="../protocol/audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr><tr><td><strong>BrainAuditAnchor</strong></td><td>The on-chain anchor contract.</td><td><a href="../smart-contracts/brainauditanchor.md">brainauditanchor.md</a></td><td></td></tr></tbody></table>
