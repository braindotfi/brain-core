# Audit API

Query audit events and pull Merkle proofs anchored to `BrainAuditAnchor` on Base.

### Get an Event

```http
GET /v1/audit/{event_id}
Authorization: Bearer <token>
```

Response:

```json
{
  "id": "audit_evt_...",
  "event_type": "action.executed",
  "tenant_id": "acme",
  "actor": "0xagent...",
  "timestamp": "2025-09-01T12:00:00Z",
  "inputs_hash": "0x...",
  "policy_version": 3,
  "decision": "ALLOW",
  "reason": null,
  "prev_event_hash": "0x...",
  "batch_index": 4719
}
```

### Pull a Merkle Proof

```http
GET /v1/audit/{event_id}/proof
Authorization: Bearer <token>
```

Response:

```json
{
  "event":          { ... },
  "merkle_path":    ["0xabc...", "0xdef..."],
  "anchored_root":  "0x...",
  "base_tx_hash":   "0x...",
  "base_block":     8829110,
  "batch_index":    4719
}
```

### Verifying a Proof

A counterparty can verify a proof in three ways.

| Method                       | Description                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| **SDK helper**               | `verifyMerkleProof(...)` from `@brain/sdk`, no Brain account required                         |
| **On-chain call**            | `BrainAuditAnchor.verify(tenantId, batchIndex, leaf, merkleProof)` from any Solidity contract |
| **Public verifier endpoint** | `POST /v1/public/audit/verify` accepts a proof bundle and returns a result                    |

Public verifier:

```http
POST /v1/public/audit/verify
Content-Type: application/json

{
  "event":          { ... },
  "merkle_path":    [...],
  "anchored_root":  "0x...",
  "tenant_id":      "0x...",
  "batch_index":    4719
}
```

Response:

```json
{
  "valid": true,
  "anchored_at": "2025-09-01T12:10:00Z",
  "anchored_block": 8829110
}
```

{% hint style="success" %}
The public verifier requires no authentication. Anyone with a proof bundle can verify it.
{% endhint %}

### List Events

```http
GET /v1/audit?tenantId=acme&from=2025-01-01&to=2025-12-31&event_type=action.executed
Authorization: Bearer <token>
```

Filters: `tenantId`, `event_type`, `actor`, `from`, `to`, `cursor`, `limit`.

### Stream Events

```
WSS /v1/audit/stream?tenantId=acme
Authorization: Bearer <token>
```

Subscribe to live events as they are written to the hash chain. Useful for SIEM integration and real-time monitoring.

### Compliance Exports

```http
POST /v1/audit/exports
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId":  "acme",
  "format":    "soc2",
  "from":      "2025-01-01",
  "to":        "2025-12-31"
}
```

Response:

```json
{
  "export_id": "exp_...",
  "format": "soc2",
  "status": "preparing",
  "expires_at": "2025-09-02T12:00:00Z",
  "download_url": null
}
```

Poll until ready:

```http
GET /v1/audit/exports/{export_id}
```

```json
{
  "status": "ready",
  "download_url": "https://s3.../soc2-acme-2025.zip?X-Amz-..."
}
```

| Format               | Coverage                                        |
| -------------------- | ----------------------------------------------- |
| `soc2`               | SOC 2 Type II evidence package                  |
| `iso27001`           | ISO 27001 evidence package                      |
| `financial_controls` | Approval chains, segregation-of-duties evidence |
| `raw_jsonl`          | Full event log as JSON Lines                    |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📜 Audit Concepts</strong></td><td>How the hash chain and Merkle anchoring work.</td><td><a href="../protocol/audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr><tr><td><strong>📜 BrainAuditAnchor</strong></td><td>The on-chain anchor contract.</td><td><a href="../smart-contracts/brainauditanchor.md">brainauditanchor.md</a></td><td></td></tr></tbody></table>
