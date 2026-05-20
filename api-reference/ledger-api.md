# Ledger API

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
    "history": [{ "id": "tx_001", "amount": "1234.56", "extractor_version": "v3.1" }]
  }
}
```

### Other Record Types

The Ledger holds more than transactions.

| Endpoint                        | Records                               |
| ------------------------------- | ------------------------------------- |
| `GET /v1/ledger/balances`       | Point-in-time and rolling balances    |
| `GET /v1/ledger/accounts`       | Tenant-side and counterparty accounts |
| `GET /v1/ledger/counterparties` | Vendors, customers, employees         |
| `GET /v1/ledger/invoices`       | Billed amounts with line items        |
| `GET /v1/ledger/obligations`    | Subscriptions, recurring charges      |
| `GET /v1/ledger/cash_flows`     | Aggregations and forecasts            |
| `GET /v1/ledger/assets`         | Holdings                              |
| `GET /v1/ledger/liabilities`    | Debts                                 |
| `GET /v1/ledger/events`         | Lifecycle events tied to records      |

### Provenance Chain

Every Ledger record carries:

| Field               | Description                                      |
| ------------------- | ------------------------------------------------ |
| `raw_refs`          | SHA-256 hashes of Raw artifacts that produced it |
| `extractor_version` | The deterministic extractor version              |
| `confidence`        | Calibrated 0 to 1 score                          |
| `supersedes`        | Optional pointer to the record this corrects     |

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

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🧠 Wiki API</strong></td><td>Reason over the Ledger in natural language.</td><td><a href="wiki-api.md">wiki-api.md</a></td><td></td></tr><tr><td><strong>📥 Raw and Ledger</strong></td><td>The conceptual model.</td><td><a href="../protocol/raw-and-ledger.md">raw-and-ledger.md</a></td><td></td></tr></tbody></table>
