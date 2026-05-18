# Sources API

Connect, list, and disconnect financial data sources for a tenant. A source is any system whose evidence flows into the Raw Layer.

### Connect a source

```http
POST /v1/sources
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId":  "acme",
  "type":      "plaid",
  "credentials": { ... },
  "metadata":  { "label": "Mercury operating account" }
}
```

```json
{
  "data": {
    "id": "src_8231",
    "tenantId": "acme",
    "type": "plaid",
    "status": "active",
    "connected_at": "2025-09-01T12:00:00Z"
  }
}
```

### Source types

| Category       | `type` Values                                     |
| -------------- | ------------------------------------------------- |
| **Banking**    | `plaid`, `bank_direct`                            |
| **On-chain**   | `alchemy_wallet`, `eth_address`, `solana_address` |
| **ERP**        | `netsuite`, `sap`, `dynamics_365`                 |
| **Accounting** | `quickbooks_online`, `xero`                       |
| **Payroll**    | `gusto`, `rippling`, `adp`                        |
| **Processors** | `stripe`, `adyen`                                 |
| **Documents**  | `email_inbound`, `csv_upload`, `pdf_upload`       |

{% hint style="info" %}
Each source type accepts a different `credentials` shape. See the source-specific guides in the Console for the exact schema per provider.
{% endhint %}

### List sources

```http
GET /v1/sources?tenantId=acme&status=active
Authorization: Bearer <token>
```

```json
{
  "data": [
    { "id": "src_8231", "type": "plaid", "status": "active" },
    { "id": "src_8232", "type": "alchemy_wallet", "status": "active" }
  ],
  "meta": { "next_cursor": null, "has_more": false }
}
```

### Get a single source

```http
GET /v1/sources/{id}
Authorization: Bearer <token>
```

### Disconnect a source

```http
DELETE /v1/sources/{id}
Authorization: Bearer <token>
```

{% hint style="warning" %}
Disconnecting a source triggers data minimization workflows: ingestion stops immediately, and per-tenant retention rules determine when historical Raw artifacts are deleted. Ledger records remain to preserve historical accuracy.
{% endhint %}

### Source status

| Status         | Meaning                                      |
| -------------- | -------------------------------------------- |
| `active`       | Ingesting normally                           |
| `paused`       | Temporarily suspended by tenant or by Brain  |
| `errored`      | Upstream credential or rate-limit issue      |
| `disconnected` | Tenant has disconnected; in retention window |
| `deleted`      | Past retention; no Raw artifacts remain      |

### Trigger a manual sync

```http
POST /v1/sources/{id}/sync
Authorization: Bearer <token>
```

### Direct raw ingestion

For sources Brain does not natively integrate, push raw artifacts directly.

```http
POST /v1/raw/ingest
Authorization: Bearer <token>
Content-Type: multipart/form-data

tenantId=acme
type=invoice_pdf
file=@invoice_8231.pdf
```

The artifact is content-addressed by SHA-256 and stored in the tenant's Azure Blob partition.

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🧾 Ledger API</strong></td><td>Query the structured records produced from sources.</td><td><a href="ledger-api.md">ledger-api.md</a></td><td></td></tr><tr><td><strong>📥 Raw and Ledger</strong></td><td>The conceptual model.</td><td><a href="../protocol/raw-and-ledger.md">raw-and-ledger.md</a></td><td></td></tr></tbody></table>
