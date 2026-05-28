# Ledger API

Query the deterministic structured records the Brain protocol produces from Raw evidence. The Ledger is the single source of financial truth — every row carries provenance, evidence references, and a confidence score.

| Operation                         | Endpoint                                        |
| --------------------------------- | ----------------------------------------------- |
| List accounts                     | `GET  /v1/ledger/accounts`                      |
| Account detail (+ latest balance) | `GET /v1/ledger/accounts/{account_id}`          |
| List balances (point-in-time)     | `GET  /v1/ledger/balances`                      |
| List counterparties               | `GET  /v1/ledger/counterparties`                |
| List invoices                     | `GET  /v1/ledger/invoices`                      |
| List obligations                  | `GET  /v1/ledger/obligations`                   |
| List transactions                 | `GET  /v1/ledger/transactions`                  |
| Transaction detail                | `GET  /v1/ledger/transactions/{transaction_id}` |
| Promote Raw → Ledger              | `POST /v1/ledger/normalize`                     |
| Trigger reconciliation            | `POST /v1/ledger/reconcile`                     |
| List reconciliation matches       | `GET  /v1/ledger/reconciliation-matches`        |

### List Transactions

```http
GET /v1/ledger/transactions?account_id=acct_ops&since=2026-01-01&until=2026-03-31&direction=outflow
Authorization: Bearer <token>
```

```json
{
  "transactions": [
    {
      "id": "tx_001",
      "account_id": "acct_ops",
      "external_transaction_id": "plaid_tx_abc",
      "amount": "-1234.56",
      "currency": "USD",
      "direction": "outflow",
      "transaction_date": "2026-01-15",
      "posted_date": "2026-01-16",
      "counterparty_id": "cp_aws",
      "category_id": "cat_cloud",
      "status": "posted",
      "description_normalized": "AWS - cloud services",
      "reconciliation_status": "matched",
      "source_ids": ["raw_8231"],
      "evidence_ids": ["rp_001"],
      "confidence": 0.98
    }
  ],
  "next_cursor": "..."
}
```

Filters: `account_id`, `counterparty_id`, `direction` (`inflow | outflow | transfer | adjustment`), `status` (`pending | posted | cleared | failed | reversed | disputed`), `since`, `until`, `limit` (default 100, max 1000), `cursor`. `amount` is a signed decimal string.

### Get a Single Transaction

```http
GET /v1/ledger/transactions/{transaction_id}
Authorization: Bearer <token>
```

Returns the same `Transaction` shape. `404` if unknown.

### List Accounts

```http
GET /v1/ledger/accounts?status=active&account_type=bank_checking&limit=50
Authorization: Bearer <token>
```

```json
{
  "accounts": [
    {
      "id": "acct_ops",
      "owner_id": "acme",
      "account_type": "bank_checking",
      "name": "Operating",
      "currency": "USD",
      "status": "active",
      "institution": "Mercury",
      "external_account_id": "plaid_acc_xyz",
      "current_balance": "182431.45",
      "available_balance": "181009.12"
    }
  ],
  "next_cursor": null
}
```

`account_type` enum: `bank_checking | bank_savings | card | loan | line_of_credit | onchain`. Filters: `status` (`active | closed | frozen | pending`), `account_type`, `limit` (default 50, max 500), `cursor`.

For one account plus its latest balance:

```http
GET /v1/ledger/accounts/{account_id}
Authorization: Bearer <token>
```

```json
{ "account": { ... }, "latest_balance": { "current_balance": "182431.45", "as_of": "2026-05-28T11:55:00Z", "currency": "USD" } }
```

### List Balances (Point-in-Time)

```http
GET /v1/ledger/balances?account_id=acct_ops&as_of=2026-03-31T23:59:59Z
Authorization: Bearer <token>
```

Returns the balance row(s) effective at `as_of` (or the latest if omitted).

### List Counterparties

```http
GET /v1/ledger/counterparties?q=AWS&type=vendor&verified_status=document_verified
Authorization: Bearer <token>
```

`type` enum: `merchant | vendor | customer | employer | bank | wallet | exchange | tax_authority | other`. `verified_status`: `unverified | self_attested | document_verified | sanctions_cleared`. Each counterparty carries `risk_level` (`low | medium | high | sanctioned`), `aliases[]`, and `linked_accounts[]`.

### List Invoices and Obligations

```http
GET /v1/ledger/invoices?status=sent
GET /v1/ledger/obligations?status=due&due_before=2026-06-30
```

`Invoice.status`: `draft | sent | partial | paid | overdue | cancelled | disputed`. `Obligation.type`: `bill | invoice | subscription | loan | rent | payroll | tax | card_statement | other`.

### Promote Raw → Ledger

Normalize a Raw-parsed row into typed Ledger entities. Idempotent — re-running with the same input returns the same Ledger row ids.

```http
POST /v1/ledger/normalize
Authorization: Bearer <token>
Content-Type: application/json

{
  "raw_parsed_id":  "rp_001",
  "target_entities": ["transaction", "counterparty"]
}
```

```json
{
  "ledger_rows_created": [
    { "entity": "transaction", "id": "tx_001" },
    { "entity": "counterparty", "id": "cp_aws" }
  ]
}
```

`target_entities` (optional) is a subset of `account | balance | transaction | counterparty | obligation | document | category | transfer | invoice`.

### Reconciliation

Trigger an async reconciliation pass:

```http
POST /v1/ledger/reconcile
Authorization: Bearer <token>
Content-Type: application/json

{ "since": "2026-03-01", "match_types": ["transaction_receipt", "invoice_payment"] }
```

`202 Accepted` → `{ "job_id": "rec_4711" }`.

List matches:

```http
GET /v1/ledger/reconciliation-matches?status=matched&match_type=invoice_payment
Authorization: Bearer <token>
```

```json
{
  "matches": [
    {
      "id": "rm_001",
      "match_type": "invoice_payment",
      "left_entity_type": "invoice",
      "left_entity_id": "inv_8231",
      "right_entity_type": "transaction",
      "right_entity_id": "tx_001",
      "confidence_score": 0.97,
      "status": "matched",
      "evidence_ids": ["rp_001"],
      "explanation": "amount + counterparty + date within tolerance"
    }
  ]
}
```

`match_type` enum: `transaction_receipt | invoice_payment | statement_balance | wallet_transfer | payroll_bank_debit | subscription_charge | card_charge`. `status`: `unmatched | matched | partially_matched | duplicate_possible | disputed | cleared | failed | reversed`.

### Provenance on Every Row

Every Ledger row carries:

| Field                       | Description                                |
| --------------------------- | ------------------------------------------ | -------- | --------- | --------------- | ------------------ |
| `source_ids`                | Raw artifact ids that produced it          |
| `evidence_ids`              | Raw-parsed row ids the extractor consulted |
| `provenance`                | `extracted                                 | inferred | ambiguous | human_confirmed | agent_contributed` |
| `confidence`                | Calibrated 0 to 1 score                    |
| `created_at` / `updated_at` | Bitemporal timestamps                      |

{% hint style="info" %}
Records are immutable. Corrections are written as **superseding** records that reference what they correct (`supersedes` field). The history is preserved end-to-end — query `GET /v1/audit/entity/{entityType}/{entityId}` for the full causal trail.
{% endhint %}

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🧠 Wiki API</strong></td><td>Reason over the Ledger in natural language.</td><td><a href="wiki-api.md">wiki-api.md</a></td><td></td></tr><tr><td><strong>📥 Raw and Ledger</strong></td><td>The conceptual model.</td><td><a href="../protocol/raw-and-ledger.md">raw-and-ledger.md</a></td><td></td></tr></tbody></table>
