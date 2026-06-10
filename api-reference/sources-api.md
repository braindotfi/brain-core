# Sources and Raw Ingestion

The Brain HTTP surface does **not** expose a `/v1/sources/*` resource family. Source connectors (Plaid, on-chain extractors, ERP integrations) are configured out-of-band via the Console or per-tenant infra wiring and they push evidence into Brain through the **Raw layer**. The Raw API is what you call to ingest artifacts directly and to inspect what's been ingested.

| Concern                                                            | API                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| Push an artifact (file, URL, or provider webhook payload) into Raw | `POST /v1/raw/ingest`, `POST /v1/raw/webhooks/{provider}` |
| Read or tombstone a Raw artifact                                   | `GET /v1/raw/{raw_id}`, `DELETE /v1/raw/{raw_id}`         |
| Read the deterministic parser output for an artifact               | `GET /v1/raw/{raw_id}/parsed`                             |
| Promote parsed Raw into typed Ledger rows                          | `POST /v1/ledger/normalize` (see Ledger API)              |

The "Source Types" table further down is the conceptual taxonomy. The `source_type` you tag an ingested artifact with, not a list of HTTP resources you create.

### Ingest a Raw Artifact

Two body shapes are supported on `POST /v1/raw/ingest`: a binary upload via `multipart/form-data`, or a URL fetch via JSON. Both are idempotent by SHA-256: a re-submitted artifact (per tenant) returns the existing `raw_id` with `deduplicated: true`.

Binary upload:

```http
POST /v1/raw/ingest
Authorization: Bearer <token>
Content-Type: multipart/form-data

source_type=pdf_upload
file=@invoice_8231.pdf
mime_type=application/pdf
```

URL fetch:

```http
POST /v1/raw/ingest
Authorization: Bearer <token>
Content-Type: application/json

{
  "source_type":  "csv_upload",
  "url":          "https://example.com/statement.csv",
  "source_ref":   { "account_id": "acct_ops" },
  "auth_header":  "Bearer <upstream-token>"
}
```

Response (201 on first ingest, 200 on dedup):

```json
{
  "raw_id": "raw_8231",
  "sha256": "abc123...",
  "source_type": "csv_upload",
  "bytes": 18420,
  "ingested_at": "2026-05-28T12:00:00Z",
  "deduplicated": false
}
```

Limits: 50 MB per artifact. Errors: `400`, `401`, `403`, `413`, `415`, `429`.

`plaid` and `stripe` are reserved on this route: artifacts of those types may only be created through the HMAC-verified provider webhook, so a caller cannot mint high-trust evidence by labeling an upload. Asserting them here returns `raw_source_reserved`.

### Source Types

The `source_type` you tag an ingested artifact with. Used for routing to the right parser.

| `source_type`       | Typical Origin                                          |
| ------------------- | ------------------------------------------------------- |
| `plaid`             | Plaid bank-account artifacts (statements, transactions) |
| `stripe`            | Stripe API objects                                      |
| `netsuite`          | NetSuite SuiteTalk extracts                             |
| `email_inbound`     | Inbound email (e.g. invoices forwarded to a mailbox)    |
| `csv_upload`        | Direct CSV file upload                                  |
| `pdf_upload`        | Direct PDF / document upload                            |
| `alchemy_wallet`    | On-chain EVM extractor output (Alchemy indexer)         |
| `eth_address`       | Watched address chain events                            |
| `agent_contributed` | Pushed by an external agent with `raw:write` scope      |
| `wiki_annotation`   | Human corrections via the Wiki annotate path (internal) |
| `other`             | Universal fallback: any source with no native connector |

{% hint style="info" %}
The webhook path (`POST /v1/raw/webhooks/{provider}`) accepts a separate, narrower `provider` enum: `plaid`, `stripe`, `alchemy`, `netsuite`, `generic_hmac`. Webhook signature verification replaces bearer auth on that route.
{% endhint %}

### Provider Webhooks

Connected providers (Plaid, Stripe, etc.) push events at:

```http
POST /v1/raw/webhooks/{provider}
Content-Type: application/json
X-Provider-Signature: <hmac>

<provider-specific payload>
```

This route has `security: []`. The HMAC signature replaces bearer auth. Brain verifies the signature, stores the payload as a Raw artifact, and returns `202 Accepted` with `{ accepted: true, request_id: "req_..." }`. A signature mismatch returns `401` with `raw_webhook_signature_invalid`.

### Read a Raw Artifact

```http
GET /v1/raw/{raw_id}
Authorization: Bearer <token>
```

```json
{
  "raw_id": "raw_8231",
  "sha256": "abc123...",
  "signed_url": "https://blob.brain.fi/...",
  "expires_at": "2026-05-28T12:10:00Z",
  "mime_type": "application/pdf",
  "bytes": 18420
}
```

The signed URL is short-lived (10-minute TTL) and returns the bytes with `Content-Disposition: attachment`. The artifact itself lives in the tenant's Azure Blob partition. `404` if unknown, `410` if tombstoned.

### Tombstone a Raw Artifact

```http
DELETE /v1/raw/{raw_id}
Authorization: Bearer <token>
```

`204 No Content`. The artifact becomes inaccessible and is filtered from Wiki, but the underlying bytes are retained per regulatory retention policy. Re-tombstoning returns `410`.

### Read the Parsed Form

After ingestion, deterministic parsers extract structured fields. Their output is queryable:

```http
GET /v1/raw/{raw_id}/parsed?parser=invoice_v2&parser_version=3.1
Authorization: Bearer <token>
```

```json
{
  "raw_id": "raw_8231",
  "parsed": [
    {
      "id": "rp_001",
      "raw_artifact_id": "raw_8231",
      "parser": "invoice_v2",
      "parser_version": "3.1",
      "extracted": { "amount": "1234.56", "currency": "USD", "due_date": "2026-06-15" },
      "confidence": 0.98,
      "extracted_at": "2026-05-28T12:00:30Z"
    }
  ]
}
```

Parsed rows are append-only; a re-run with a new `parser_version` produces a new row rather than mutating the old one.

### Promoting Raw to Ledger

Parsed Raw becomes typed Ledger rows via `POST /v1/ledger/normalize` (documented in the Ledger API). Normalization is idempotent. The same `raw_parsed_id` produces the same Ledger row ids on re-run.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🧾 Ledger API</strong></td><td>Query the structured records produced from Raw.</td><td><a href="ledger-api.md">ledger-api.md</a></td><td></td></tr><tr><td><strong>📥 Raw and Ledger</strong></td><td>The conceptual model.</td><td><a href="../protocol/raw-and-ledger.md">raw-and-ledger.md</a></td><td></td></tr></tbody></table>
