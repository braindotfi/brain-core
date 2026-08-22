# Sources and Raw Ingestion

Brain exposes `/v1/sources/*` for tenant-scoped source records and the Raw API
for the evidence those sources produce. Live connectors such as Plaid can hold
encrypted credentials and run sync cycles. A source with `status: historical`
is provenance metadata only: it has no live provider connection, stores no
credentials, and cannot sync. This lets imported or curated Ledger data name
its origin without claiming that Brain is actively connected to that system.

| Concern                                                            | API                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| List source records                                                | `GET /v1/sources`                                         |
| Read one source record                                             | `GET /v1/sources/{source_id}`                             |
| Connect or disconnect a live source                                | `POST /v1/sources`, `DELETE /v1/sources/{source_id}`      |
| Trigger a live source sync                                         | `POST /v1/sources/{source_id}/sync`                       |
| Push an artifact (file, URL, or provider webhook payload) into Raw | `POST /v1/raw/ingest`, `POST /v1/raw/webhooks/{provider}` |
| Read or tombstone a Raw artifact                                   | `GET /v1/raw/{raw_id}`, `DELETE /v1/raw/{raw_id}`         |
| Trigger asynchronous document extraction                           | `POST /v1/raw/{raw_id}/extract`                           |
| Read extraction status                                             | `GET /v1/raw/{raw_id}/extraction`                         |
| Read the deterministic parser output for an artifact               | `GET /v1/raw/{raw_id}/parsed`                             |
| Promote parsed Raw into typed Ledger rows                          | `POST /v1/ledger/normalize` (see Ledger API)              |

The "Source Types" table further down is the shared connector and artifact
origin taxonomy. A source record uses `type`; an ingested artifact uses the
corresponding `source_type`.

### Source lifecycle status

| `status`       | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `active`       | A configured source eligible for live sync                                |
| `paused`       | A configured source whose sync is intentionally paused                    |
| `error`        | A configured source that needs attention after a connection or sync error |
| `disconnected` | A former connection that is no longer available                           |
| `historical`   | Provenance for prior imports or curated data, with no live connection     |

Historical source freshness is `not_applicable`, and attempts to sync one fail
with `raw_source_unsupported`.

### Ingest a Raw Artifact

Two body shapes are supported on `POST /v1/raw/ingest`: a binary upload via `multipart/form-data`, or a URL fetch via JSON. Both are idempotent by SHA-256: a re-submitted artifact (per tenant) returns the existing `raw_id` with `deduplicated: true`.

#### Bring your own source

Use `source_type: other` to submit an artifact from a source without a native
Brain connector. This route requires a bearer principal with `raw:write`: a
human JWT or a registered SIWX agent JWT that was granted that scope. Standard
`brain_sk_` tenant API keys are read-only and cannot be issued `raw:write`; at
launch API-key authentication is also disabled on the production API. A custom
artifact is stored as raw evidence and is projected only after a compatible
parser is registered. It is not a direct arbitrary Ledger-event write API.

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

`plaid`, `stripe`, `finch`, and `merge_accounting` are reserved on this route: those source types are provider-authenticated only and may be created solely through their authenticated provider integration, so a caller cannot mint high-trust evidence by labeling an upload. Asserting any of them here returns `raw_source_reserved`.

#### Structured CSV uploads

`csv_upload` supports deterministic, customer-asserted CSV records when the
ingestion envelope declares `object_type`. The supported values are
`counterparties`, `payables_invoices`, `receivables_invoices`, `payroll_runs`,
and `tax_obligations`.

The object type is required because payable and receivable invoice files can
have identical columns. Brain never infers their direction from filenames or
row values. `payables_invoices` always projects payable obligations, while
`receivables_invoices` always projects receivable obligations. A
`counterparties` file creates only counterparties: fields such as `first_seen`
remain reference metadata and cannot become transaction or due dates.
Projected invoice reads include both `counterparty_id` and the resolved
`counterparty_name` when the declared counterparty CSV has been ingested.

```http
POST /v1/raw/ingest
Authorization: Bearer <token with raw:write>
Content-Type: multipart/form-data

source_type=csv_upload
object_type=payables_invoices
file=@payables_invoices.csv
mime_type=text/csv
```

Required headers are validated per object type. Ingestion itself returns `201`.
An unsupported or undeclared CSV schema fails asynchronously and is reported by
`GET /v1/raw/{raw_id}/extraction` as `status: "failed"` with an error object. It
is never sent to the LLM document extractor. Legacy AR-aging and payroll-register
uploads remain supported by their existing deterministic parsers.

### Source Types

The `source_type` you tag an ingested artifact with. Used for routing to the right parser.

| `source_type`       | Typical Origin                                          |
| ------------------- | ------------------------------------------------------- |
| `plaid`             | Plaid bank-account artifacts (statements, transactions) |
| `stripe`            | Stripe API objects                                      |
| `netsuite`          | NetSuite SuiteTalk extracts                             |
| `merge_accounting`  | Merge.dev accounting integrations (QuickBooks, Xero)    |
| `finch`             | Finch payroll and HR provider extracts                  |
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

This route has `security: []`. The HMAC signature replaces bearer auth. Brain verifies the signature, stores the payload as one or more Raw artifacts, and returns `202 Accepted` with `{ accepted: true, trace_id: "...", artifacts: 1 }`, where `artifacts` is the count persisted (`0` on an idempotent replay). A signature mismatch returns `401` with `raw_webhook_signature_invalid`.

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

### Trigger and Inspect Document Extraction

Start asynchronous extraction for an existing Raw artifact:

```http
POST /v1/raw/{raw_id}/extract
Authorization: Bearer <token with raw:write>
Content-Type: application/json

{ "retry": false }
```

The route returns `202` while the job is queued or running, and `200` for an
existing terminal success. A failed terminal job is returned as a `502` with its
stored extraction error. Set `retry: true` to explicitly requeue a terminal job.

Poll its current state with `raw:read`:

```http
GET /v1/raw/{raw_id}/extraction
Authorization: Bearer <token>
```

```json
{
  "job_id": "extract_001",
  "raw_id": "raw_8231",
  "status": "succeeded",
  "parsed_id": "rp_001",
  "confidence": 0.98,
  "error": null,
  "next_attempt_at": null,
  "created_at": "2026-05-28T12:00:00Z",
  "updated_at": "2026-05-28T12:00:30Z"
}
```

### Promoting Raw to Ledger

Parsed Raw becomes typed Ledger rows via `POST /v1/ledger/normalize` (documented in the Ledger API). Normalization is idempotent. The same `raw_parsed_id` produces the same Ledger row ids on re-run.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🧾 Ledger API</strong></td><td>Query the structured records produced from Raw.</td><td><a href="ledger-api.md">ledger-api.md</a></td><td></td></tr><tr><td><strong>📥 Raw and Ledger</strong></td><td>The conceptual model.</td><td><a href="../protocol/raw-and-ledger.md">raw-and-ledger.md</a></td><td></td></tr></tbody></table>
