# Audit

Query audit events and pull Merkle proofs anchored to `BrainAuditAnchor` on Base.

### Get an Event

```http
GET /v1/audit/{event_id}
Authorization: Bearer <token>
```

Response:

```json
{
  "id":               "audit_evt_...",
  "event_type":       "action.executed",
  "tenant_id":        "acme",
  "actor":            "0xagent...",
  "timestamp":        "2025-09-01T12:00:00Z",
  "inputs_hash":      "0x...",
  "policy_version":   3,
  "decision":         "ALLOW",
  "reason":           null,
  "prev_event_hash":  "0x...",
  "batch_index":      4719
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

<table><thead><tr><th width="250">Method</th><th>Description</th></tr></thead><tbody><tr><td><strong>SDK helper</strong></td><td><code>verifyMerkleProof(...)</code> from <code>@brain/sdk</code>, no Brain account required</td></tr><tr><td><strong>On-chain call</strong></td><td><code>BrainAuditAnchor.verify(tenantId, batchIndex, leaf, merkleProof)</code> from any Solidity contract</td></tr><tr><td><strong>Public verifier endpoint</strong></td><td><code>POST /v1/public/audit/verify</code> accepts a proof bundle and returns a result</td></tr></tbody></table>

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
  "valid":          true,
  "anchored_at":    "2025-09-01T12:10:00Z",
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
  "export_id":    "exp_...",
  "format":       "soc2",
  "status":       "preparing",
  "expires_at":   "2025-09-02T12:00:00Z",
  "download_url": null
}
```

Poll until ready:

```http
GET /v1/audit/exports/{export_id}
```

```json
{
  "status":       "ready",
  "download_url": "https://s3.../soc2-acme-2025.zip?X-Amz-..."
}
```

<table><thead><tr><th width="250">Format</th><th>Coverage</th></tr></thead><tbody><tr><td><code>soc2</code></td><td>SOC 2 Type II evidence package</td></tr><tr><td><code>iso27001</code></td><td>ISO 27001 evidence package</td></tr><tr><td><code>financial_controls</code></td><td>Approval chains, segregation-of-duties evidence</td></tr><tr><td><code>raw_jsonl</code></td><td>Full event log as JSON Lines</td></tr></tbody></table>
