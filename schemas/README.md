# Wiki JSON Schemas

Per §3 Layer 2 of `Brain_MVP_Architecture.md`, every Wiki entity `kind` has a
JSON Schema that validates its `attributes` JSONB column. Relations similarly.

Schemas land in stage-3 alongside the Wiki layer. Versioned. Backward compatible.

### MVP entity kinds (§3 Layer 2)

- `account`
- `counterparty`
- `transaction`
- `obligation`
- `policy`
- `agent`

### MVP relation kinds

- `transacted_with`
- `owes`
- `owed_by`
- `governed_by`

### Provenance values

- `extracted`
- `inferred`
- `ambiguous`
- `human_confirmed`
- `agent_contributed`

Agent-contributed entities start at a confidence ceiling of 0.5. Promotion
requires corroboration or explicit tenant approval — see §3 Layer 2.
