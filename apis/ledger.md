# Ledger

Query the deterministic structured records produced from Raw evidence.

### List Transactions

```http
GET /v1/ledger/transactions?tenantId=acme&from=2025-01-01&to=2025-03-31
Authorization: Bearer <token>
```

```json
{
  "data": [
    {
      "id": "tx_001",
      "tenantId": "acme",
      "amount": "1234.56",
      "currency": "USD",
      "date": "2025-01-15",
      "counterparty_id": "cp_aws",
      "raw_refs": ["sha256:abc..."],
      "extractor_version": "v3.1",
      "confidence": 0.98,
      "supersedes": null
    }
  ],
  "meta": { "next_cursor": "...", "has_more": true }
}
```

### Filter Transactions

| Query Param                | Type     | Description                |
| -------------------------- | -------- | -------------------------- |
| `tenantId`                 | string   | Required                   |
| `from`, `to`               | ISO date | Inclusive range            |
| `counterparty_id`          | string   | Filter to one counterparty |
| `account_id`               | string   | Filter to one account      |
| `min_amount`, `max_amount` | decimal  | Amount range               |
| `currency`                 | string   | ISO 4217                   |
| `confidence_min`           | float    | Minimum confidence score   |
| `include_superseded`       | boolean  | Default false              |

### Get a Single Record

```http
GET /v1/ledger/{id}
Authorization: Bearer <token>
```

The response includes the full provenance chain.

```json
{
  "data": {
    "id": "tx_002",
    "amount": "1234.65",
    "supersedes": "tx_001",
    "raw_refs": ["sha256:def..."],
    "extractor_version": "v3.2",
    "confidence": 1.0,
    "history": [
      { "id": "tx_001", "amount": "1234.56", "extractor_version": "v3.1" }
    ]
  }
}
```

### Other Record Types

The Ledger holds more than transactions.

<table><thead><tr><th width="350">Endpoint</th><th>Records</th></tr></thead><tbody><tr><td><code>GET /v1/ledger/balances</code></td><td>Point-in-time and rolling balances</td></tr><tr><td><code>GET /v1/ledger/accounts</code></td><td>Tenant-side and counterparty accounts</td></tr><tr><td><code>GET /v1/ledger/counterparties</code></td><td>Vendors, customers, employees</td></tr><tr><td><code>GET /v1/ledger/invoices</code></td><td>Billed amounts with line items</td></tr><tr><td><code>GET /v1/ledger/obligations</code></td><td>Subscriptions, recurring charges</td></tr><tr><td><code>GET /v1/ledger/cash_flows</code></td><td>Aggregations and forecasts</td></tr><tr><td><code>GET /v1/ledger/assets</code></td><td>Holdings</td></tr><tr><td><code>GET /v1/ledger/liabilities</code></td><td>Debts</td></tr><tr><td><code>GET /v1/ledger/events</code></td><td>Lifecycle events tied to records</td></tr></tbody></table>

### Provenance Chain

Every Ledger record carries:

<table><thead><tr><th width="250">Field</th><th>Description</th></tr></thead><tbody><tr><td><code>raw_refs</code></td><td>SHA-256 hashes of Raw artifacts that produced it</td></tr><tr><td><code>extractor_version</code></td><td>The deterministic extractor version</td></tr><tr><td><code>confidence</code></td><td>Calibrated 0 to 1 score</td></tr><tr><td><code>supersedes</code></td><td>Optional pointer to the record this corrects</td></tr></tbody></table>

{% hint style="info" %}
Records are immutable. Corrections are written as superseding records that reference what they correct. The history is preserved.
{% endhint %}

### Reconcile Mode

For records below a confidence threshold, Brain queues them in a reconciliation queue. The API exposes the queue for human review.

```http
GET /v1/ledger/reconciliation_queue?tenantId=acme&confidence_max=0.7
Authorization: Bearer <token>
```

### Subscribe to Changes

For real-time updates, use the WebSocket endpoint.

```
wss://api.brain.fi/v1/ledger/stream?tenantId=acme&token=<bearer>
```

Each message is a structured event: `record.created`, `record.superseded`, `record.confidence_updated`.
