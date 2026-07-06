# Manual Counterparty Endpoints

This contract covers the Ledger-owned manual counterparty surface. Core leads
this model. Clients must use these endpoints instead of writing Ledger rows or
payment instructions directly.

## Endpoints

### `GET /ledger/counterparties`

Scope: `ledger:read`.

Query parameters:

- `q`: optional string. Matches normalized name by substring and aliases by
  exact case-folded match.
- `type`: optional counterparty type.
- `verified_status`: optional verification status. Allowed values are
  `unverified`, `self_attested`, `document_verified`, and
  `sanctions_cleared`.
- `limit`: optional integer. Defaults to 50 and is capped by Ledger service
  limits.

Response:

```json
{
  "counterparties": []
}
```

### `GET /ledger/counterparties/:counterparty_id`

Scope: `ledger:read`.

Returns the tenant-scoped counterparty row. Missing or cross-tenant ids return
`ledger_row_not_found`.

### `POST /ledger/counterparties`

Scope: `ledger:write`.

Accepted body:

```json
{
  "name": "Acme Trading LLC",
  "display_name": "Acme Trading",
  "type": "vendor",
  "country": "AE",
  "tax_id": "100123456700003",
  "category": "logistics",
  "contact_email": "billing@acme.example",
  "aliases": ["Acme LLC"]
}
```

Rules:

- `name` and `type` are required.
- `display_name`, `category`, `contact_email`, `country`, and `tax_id` are
  stored in Ledger metadata.
- `display_name` defaults to `name` in responses when unset.
- When `display_name` is present and differs from `name`, Ledger appends it to
  aliases so search can find the row by either label.
- `aliases` are merged with existing aliases on dedupe.
- Provenance, confidence, verification status, and risk level are server
  derived. Request bodies cannot set them.
- User principals create `human_confirmed` rows. Agent and API partner
  principals create `agent_contributed` rows with low-trust confidence.
- Manual creates always start with `verified_status = "unverified"`.
- Duplicate `(tenant, normalized_name, type)` rows are merged through the
  Ledger writer.
- New vendor rows emit the `vendor.created` domain event for vendor risk
  routing.

Responses:

- `201 { counterparty, created: true, merged: false }`
- `200 { counterparty, created: false, merged: true }`

### `PATCH /ledger/counterparties/:counterparty_id`

Scope: `ledger:write`.

Accepted body fields:

- `name`
- `display_name`
- `category`
- `contact_email`
- `country`
- `tax_id`
- `aliases`

Rules:

- Identity edits require a user principal. Agent principals remain propose-only
  and cannot stamp `human_confirmed` provenance.
- Manual create is scope-gated in v1. Manual identity edit is scope-gated and
  user-principal gated. Member resolution is not required by this Ledger surface
  in v1. Actor attribution still comes from authenticated server context and is
  recorded in audit events.
- A rename automatically preserves the previous name as an alias.
- Updating `display_name` automatically preserves the previous display name as
  an alias. This does not rename the counterparty, change `normalized_name`, or
  run rename collision checks.
- Aliases are append-only through this path.
- A rename collision with another tenant-scoped row returns
  `ledger_reconciliation_conflict` with reason `name_conflict` and
  `conflicting_counterparty_id`.
- A human identity edit stamps provenance to `human_confirmed`.
- The route emits `ledger.counterparty.updated` with `changed_fields`.

Response:

```json
{
  "counterparty": {}
}
```

## Rejected Fields

The manual create and edit endpoints reject payment instruction fields with
reason `payment_fields_not_allowed`. Rejected keys include anything resembling
IBAN, account number, routing number, SWIFT, BIC, wallet, or bank details.

The manual create and edit endpoints reject trust state fields with reason
`field_not_editable`. Rejected fields include `provenance`, `confidence`,
`verified_status`, and `risk_level`.

Unknown body fields are rejected with reason `unknown_field`. This is distinct
from `field_not_editable`, which is reserved for trust state fields that exist
but are server-controlled.

Payment instructions remain exclusively in
`ledger_counterparty_payment_instructions` through the guarded Ledger writer.
Manual counterparties can never carry manually entered payment rails.
