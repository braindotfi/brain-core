# Wiki API

Natural-language and structured access to the tenant's memory graph.

### Ask a Question

```http
POST /v1/wiki/question
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId": "acme",
  "question": "What did we spend on AWS last quarter, by environment?"
}
```

```json
{
  "data": {
    "text": "Last quarter (2025-Q2), Acme spent $182,431 on AWS across three environments: production ($138,212), staging ($31,005), and dev ($13,214). Production spend grew 12% versus 2025-Q1...",
    "citations": [
      { "type": "ledger", "id": "tx_4127" },
      { "type": "ledger", "id": "tx_4128" },
      { "type": "raw", "id": "sha256:abc..." }
    ],
    "policy_version": "v3",
    "audit_event_id": "evt_a1b2c3..."
  }
}
```

{% hint style="info" %}
Every Wiki answer carries provenance. Follow `citations[]` back to Ledger records and Raw artifacts. There is no claim Brain cannot back up with a source.
{% endhint %}

### Search Entities

```http
POST /v1/wiki/search
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId": "acme",
  "type":     "counterparty",
  "query":    "AWS",
  "limit":    10
}
```

```json
{
  "data": [
    {
      "id": "cp_aws",
      "type": "counterparty",
      "name": "Amazon Web Services",
      "score": 0.97
    }
  ]
}
```

### Get an Entity

```http
GET /v1/wiki/entities/{id}?tenantId=acme
Authorization: Bearer <token>
```

```json
{
  "data": {
    "id": "cp_aws",
    "type": "counterparty",
    "name": "Amazon Web Services",
    "attributes": {
      "tax_id": "...",
      "primary_account_id": "acct_aws_main"
    },
    "relationships": [
      { "to": "acct_aws_main", "type": "billed_via" },
      { "to": "cc_engineering", "type": "charged_to" }
    ],
    "recent_ledger": [{ "id": "tx_4127", "date": "2025-08-01", "amount": "61404.12" }]
  }
}
```

### Walk Relationships

```http
GET /v1/wiki/entities/{id}/relationships?tenantId=acme
Authorization: Bearer <token>
```

### Semantic Search

For free-text queries that don't fit entity types:

```http
POST /v1/wiki/semantic_search
Authorization: Bearer <token>
Content-Type: application/json

{
  "tenantId": "acme",
  "query":    "unusual increase in cloud costs",
  "k":        5
}
```

```json
{
  "data": [
    {
      "entity_id": "cp_aws",
      "narrative_id": "narr_q2_summary",
      "score": 0.91,
      "snippet": "AWS spend grew 12% in Q2 versus Q1, driven by..."
    }
  ]
}
```

### Subscribe to Updates

```
wss://api.brain.fi/v1/wiki/stream?tenantId=acme&token=<bearer>
```

Events: `entity.updated`, `narrative.added`, `summary.refreshed`.

### Provenance Fields

| Field            | Description                                         |
| ---------------- | --------------------------------------------------- |
| `citations[]`    | IDs of Ledger and Raw records the answer depends on |
| `policy_version` | Active policy version when the query ran            |
| `audit_event_id` | Audit event under which the call was logged         |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🧠 The Wiki</strong></td><td>The conceptual model.</td><td><a href="../protocol/the-wiki.md">the-wiki.md</a></td><td></td></tr></tbody></table>
