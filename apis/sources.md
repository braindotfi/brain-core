# Sources

Connect, list, and disconnect financial data sources for a tenant. A source is any system whose evidence flows into the Raw Layer.

### Connect a Source

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

### Source Types

<table data-header-hidden><thead><tr><th width="250"></th><th></th></tr></thead><tbody><tr><td>Category</td><td><code>type</code> Values</td></tr><tr><td><strong>Banking</strong></td><td><code>plaid</code>, <code>bank_direct</code></td></tr><tr><td><strong>On-chain</strong></td><td><code>alchemy_wallet</code>, <code>eth_address</code>, <code>solana_address</code></td></tr><tr><td><strong>ERP</strong></td><td><code>netsuite</code>, <code>sap</code>, <code>dynamics_365</code></td></tr><tr><td><strong>Accounting</strong></td><td><code>quickbooks_online</code>, <code>xero</code></td></tr><tr><td><strong>Payroll</strong></td><td><code>gusto</code>, <code>rippling</code>, <code>adp</code></td></tr><tr><td><strong>Processors</strong></td><td><code>stripe</code>, <code>adyen</code></td></tr><tr><td><strong>Documents</strong></td><td><code>email_inbound</code>, <code>csv_upload</code>, <code>pdf_upload</code></td></tr></tbody></table>

{% hint style="info" %}
Each source type accepts a different `credentials` shape. See the source-specific guides in the Console for the exact schema per provider.
{% endhint %}

### List Sources

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

### Get a Single Source

```http
GET /v1/sources/{id}
Authorization: Bearer <token>
```

### Disconnect a Source

```http
DELETE /v1/sources/{id}
Authorization: Bearer <token>
```

{% hint style="warning" %}
Disconnecting a source triggers data minimization workflows: ingestion stops immediately, and per-tenant retention rules determine when historical Raw artifacts are deleted. Ledger records remain to preserve historical accuracy.
{% endhint %}

### Source Status

<table><thead><tr><th width="250">Status</th><th>Meaning</th></tr></thead><tbody><tr><td><code>active</code></td><td>Ingesting normally</td></tr><tr><td><code>paused</code></td><td>Temporarily suspended by tenant or by Brain</td></tr><tr><td><code>errored</code></td><td>Upstream credential or rate-limit issue</td></tr><tr><td><code>disconnected</code></td><td>Tenant has disconnected; in retention window</td></tr><tr><td><code>deleted</code></td><td>Past retention; no Raw artifacts remain</td></tr></tbody></table>

### Trigger a Manual Sync

```http
POST /v1/sources/{id}/sync
Authorization: Bearer <token>
```

### Direct Raw Ingestion

For sources Brain does not natively integrate, push raw artifacts directly.

```http
POST /v1/raw/ingest
Authorization: Bearer <token>
Content-Type: multipart/form-data

tenantId=acme
type=invoice_pdf
file=@invoice_8231.pdf
```

The artifact is content-addressed by SHA-256 and stored in the tenant's S3 partition.
