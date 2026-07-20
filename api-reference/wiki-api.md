# Wiki API

Natural-language and structured access to the tenant's memory graph. The Wiki is downstream of the Ledger. Narrative, evidence-cited recall. And is never the source of truth for balances, transactions, or permissions.

| Operation                        | Endpoint                                    |
| -------------------------------- | ------------------------------------------- |
| Ask a natural-language question  | `POST /v1/wiki/question`                    |
| Search entities                  | `GET  /v1/wiki/search`                      |
| Get an entity                    | `GET  /v1/wiki/entity/{entity_id}`          |
| Evidence chain for an entity     | `GET  /v1/wiki/entity/{entity_id}/evidence` |
| Temporal history for an entity   | `GET  /v1/wiki/entity/{entity_id}/history`  |
| Annotate (human correction)      | `POST /v1/wiki/annotate`                    |
| Get the entity-kind JSON Schemas | `GET  /v1/wiki/schema`                      |
| List memory pages                | `GET  /v1/memory/pages`                     |
| Get a memory page                | `GET  /v1/memory/pages/{slug_or_id}`        |
| Regenerate a memory page         | `POST /v1/memory/regenerate`                |
| Search memory pages              | `GET  /v1/memory/search`                    |

### Ask a Question

```http
POST /v1/wiki/question
Authorization: Bearer <token>
Content-Type: application/json

{
  "question":             "What did we spend on AWS last quarter, by environment?",
  "as_of":                "2026-03-31T23:59:59Z",
  "max_evidence_depth":   3
}
```

```json
{
  "question": "What did we spend on AWS last quarter, by environment?",
  "answer": "In 2026-Q1, Acme spent $182,431 on AWS across three environments: production ($138,212), staging ($31,005), and dev ($13,214)...",
  "confidence": 0.94,
  "evidence_path": [
    { "raw_id": "raw_8231", "parser": "invoice_v2", "confidence": 0.98 },
    { "ledger_id": "tx_4127" },
    { "ledger_id": "tx_4128" }
  ],
  "llm_metadata": {
    "model": "claude-...",
    "tokens_input": 4123,
    "tokens_output": 612,
    "latency_ms": 1841
  }
}
```

`question` is 1–2000 chars. `max_evidence_depth` defaults to 3 (max 5). This route puts an LLM in the hot path. Per-call costs apply. Every answer carries `evidence_path` back to Ledger rows and Raw artifacts.

### Search Entities

```http
GET /v1/wiki/search?kind=policy&q=wire&limit=10
Authorization: Bearer <token>
```

```json
{
  "results": [
    {
      "id": "ent_policy_v4",
      "kind": "policy",
      "attributes": { "name": "Wire approval policy v4" },
      "valid_from": "2025-01-15",
      "valid_to": null,
      "provenance": "human_confirmed",
      "confidence": 1.0,
      "source_evidence": ["raw_8231"]
    }
  ],
  "next_cursor": null
}
```

Query params: `kind` (`policy | agent`), `q` (full-text), `semantic` (pgvector), `since`, `until`, `limit` (default 50, max 500), `cursor`. Pass `semantic=<string>` to run a pgvector similarity search instead of (or in addition to) full-text.

Wiki search returns only Wiki-resident kinds. The four Ledger kinds (`account`, `counterparty`, `transaction`, `obligation`) are rejected with `request_params_invalid` and a redirect hint to the corresponding `/v1/ledger/*` endpoint, since financial truth lives in the Ledger, not the Wiki.

### Get an Entity

```http
GET /v1/wiki/entity/{entity_id}?include_neighbors=true&as_of=2026-03-31T23:59:59Z
Authorization: Bearer <token>
```

```json
{
  "entity": {
    "id": "cp_aws",
    "kind": "counterparty",
    "attributes": { "name": "Amazon Web Services", "tax_id": "..." },
    "valid_from": "2025-01-15",
    "valid_to": null,
    "provenance": "extracted",
    "confidence": 0.97,
    "source_evidence": ["raw_8231"]
  },
  "neighbors": [
    { "relation": { "type": "billed_via" }, "entity": { "id": "acct_aws_main", "kind": "account" } }
  ]
}
```

`as_of` enables bitemporal reads. The entity as it was known at that moment.

### Evidence Chain

The full provenance trail behind a Wiki entity:

```http
GET /v1/wiki/entity/{entity_id}/evidence
Authorization: Bearer <token>
```

```json
{
  "entity_id": "cp_aws",
  "chain": [
    {
      "raw_parsed_id": "rp_001",
      "parser": "invoice_v2",
      "confidence": 0.98,
      "extracted_fields": ["counterparty.name", "counterparty.tax_id"]
    }
  ]
}
```

### Temporal History

Every version of the entity, oldest first:

```http
GET /v1/wiki/entity/{entity_id}/history
Authorization: Bearer <token>
```

```json
{
  "entity_id": "cp_aws",
  "versions": [
    { "id": "cp_aws", "valid_from": "2025-01-15", "valid_to": "2025-06-01", "attributes": {...} },
    { "id": "cp_aws", "valid_from": "2025-06-01", "valid_to": null,         "attributes": {...} }
  ]
}
```

### Annotate (Human Correction)

A human can correct a Wiki entity or relation; the annotation is applied as a **new temporal version** with `provenance: "human_confirmed"` rather than mutating the prior row.

```http
POST /v1/wiki/annotate
Authorization: Bearer <token>
Content-Type: application/json

{
  "entity_id":   "cp_aws",
  "corrections": { "name": "Amazon Web Services, Inc." },
  "note":        "Updated to legal name from latest contract"
}
```

The body is `oneOf`: an `EntityAnnotation` (above) or a `RelationAnnotation` (`relation_id` instead of `entity_id`).

```json
{ "annotation_id": "ann_001", "new_version_id": "cp_aws_v3" }
```

### Get the Entity-Kind Schemas

The JSON Schema(s) describing every Wiki entity kind:

```http
GET /v1/wiki/schema?kind=counterparty
Authorization: Bearer <token>
```

Returns `{ counterparty: <JSON Schema document>, ... }`. Omit `kind` for the full set.

### Memory Pages

Memory pages are pre-rendered narrative views (Markdown) over the Ledger graph. "the AWS page," "Q1 cash flow," "vendor X relationship." Browsable and searchable.

```http
GET /v1/memory/pages?page_type=counterparty&q=AWS
Authorization: Bearer <token>
```

```json
{
  "pages": [
    {
      "id": "wp_001",
      "page_type": "counterparty",
      "subject_id": "cp_aws",
      "slug": "amazon-web-services",
      "body_md": "# Amazon Web Services\n...",
      "rendered_at": "2026-05-28T11:00:00Z",
      "source_revision": "rev_4127"
    }
  ]
}
```

`page_type` enum: `account | counterparty | obligation | invoice | agent | policy | monthly_summary | cash_flow`.

Get one page by slug or id:

```http
GET /v1/memory/pages/{slug_or_id}
Authorization: Bearer <token>
```

Regenerate a page (after the underlying Ledger has changed):

```http
POST /v1/memory/regenerate
Authorization: Bearer <token>
Content-Type: application/json

{ "slug_or_id": "amazon-web-services" }
```

Search memory pages by content:

```http
GET /v1/memory/search?q=cloud%20overspend&limit=20
Authorization: Bearer <token>
```

```json
{
  "results": [
    { "page": { "id": "wp_001", "slug": "amazon-web-services", ... }, "score": 0.91 }
  ]
}
```

### Provenance Fields

| Field             | Description                                         |
| ----------------- | --------------------------------------------------- | -------- | --------- | --------------- | ------------------ |
| `evidence_path`   | Ledger and Raw refs the answer depends on (Q&A)     |
| `source_evidence` | Raw refs the entity was extracted from (entity get) |
| `provenance`      | `extracted                                          | inferred | ambiguous | human_confirmed | agent_contributed` |
| `confidence`      | Calibrated 0 to 1 score                             |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🧠 The Wiki</strong></td><td>The conceptual model.</td><td><a href="../protocol/the-wiki.md">the-wiki.md</a></td><td></td></tr></tbody></table>
