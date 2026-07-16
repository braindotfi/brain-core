# Audit API

Query audit events, pull a Merkle inclusion proof, verify a proof independently, walk the full history for any Ledger entity, export, and pull the canonical **Proof** for an action. All event payloads land in the append-only hash chain and are batch-anchored to `BrainAuditAnchor` on Base.

| Operation                         | Endpoint                                        |
| --------------------------------- | ----------------------------------------------- |
| Get the latest anchor             | `GET  /v1/audit/anchor/latest`                  |
| Walk an entity's history          | `GET  /v1/audit/entity/{entityType}/{entityId}` |
| Get one event (+ inclusion proof) | `GET  /v1/audit/event/{event_id}`               |
| Query events                      | `GET  /v1/audit/events`                         |
| Export                            | `POST /v1/audit/export`                         |
| Independent verification          | `POST /v1/audit/verify`                         |
| Canonical Proof for an action     | See the [Proof API](proof-api.md)               |

### Get the Latest Anchor

```http
GET /v1/audit/anchor/latest
Authorization: Bearer <token>
```

```json
{
  "merkle_root": "0xabc...",
  "event_count": 4127,
  "period_start": "2026-05-28T11:00:00Z",
  "period_end": "2026-05-28T11:30:00Z",
  "onchain_tx_hash": "0xdef...",
  "onchain_block_number": 8829110
}
```

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
      "tenant_id": "acme",
      "layer": "agent",
      "actor": "ag_payment_v1",
      "action": "payment_intent.proposed",
      "inputs": { "evidence_ids": ["rp_001"], "policy_version": 4 },
      "outputs": { "payment_intent_id": "pi_a1b2c3" },
      "policy_decision_id": "pd_7331",
      "before_state": null,
      "after_state": "proposed",
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
and an on-chain `BrainAuditAnchor.verify(...)` view function. Three independent
paths to the same conclusion.

### Export

```http
POST /v1/audit/export
Authorization: Bearer <token>
Content-Type: application/json

{
  "format":  "jsonl",
  "since":   "2026-01-01",
  "until":   "2026-05-28",
  "layers":  ["agent", "execution"]
}
```

`format` is `jsonl` or `csv`. Response (`202 Accepted`):

```json
{ "job_id": "exp_4711", "status_url": "https://api.brain.fi/v1/audit/export/exp_4711" }
```

Poll `status_url` until the job is ready (the URL is returned by the API; the spec does not pin a fixed `/exports/{id}` shape).

### The Canonical Proof for an Action

For investor / compliance / counterparty use cases, the flagship artifact is the per-action **Proof**. Assembled from the §6 gate trace, evidence chain, policy decision, and anchored audit Merkle chain. It has its own page so this one can stay focused on raw events and anchors.

[**Proof API**](proof-api.md)

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Proof API</strong></td><td>The per-action trust artifact.</td><td><a href="proof-api.md">proof-api.md</a></td><td></td></tr><tr><td><strong>Audit Concepts</strong></td><td>How the hash chain and Merkle anchoring work.</td><td><a href="../protocol/audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr><tr><td><strong>BrainAuditAnchor</strong></td><td>The on-chain anchor contract.</td><td><a href="../smart-contracts/brainauditanchor.md">brainauditanchor.md</a></td><td></td></tr></tbody></table>
