# Policy API

Compose a policy, sign it, activate it, evaluate proposed actions against it, and lint or simulate before signing. Every Policy route is tenant-scoped: the `{tenant_id}` (UUID) appears in the path, and your token's tenant must match.

| Operation                  | Endpoint                                          |
| -------------------------- | ------------------------------------------------- |
| Get the active policy      | `GET  /v1/policy/{tenant_id}`                     |
| Compose a candidate policy | `POST /v1/policy/{tenant_id}/compose`             |
| Sign + activate            | `POST /v1/policy/{tenant_id}/sign`                |
| List versions              | `GET  /v1/policy/{tenant_id}/versions`            |
| Evaluate an action         | `POST /v1/policy/{tenant_id}/evaluate`            |
| Lint a draft               | `POST /v1/policy/{tenant_id}/lint`                |
| Simulate against a version | `POST /v1/policy/{tenant_id}/simulate`            |
| Replay a period            | `POST /v1/policy/{tenant_id}/simulate-historical` |
| Diff two versions          | `POST /v1/policy/{tenant_id}/diff`                |

There is no separate `register` or `revoke` endpoint. Activation happens at `sign`, and superseding a version means signing a new one. The previous active version is recorded in `versions` history.

### Compose a Candidate Policy

The DSL is structured JSON, not prose. The compose route validates it and returns the canonical hash plus the EIP-712 typed-data payload the tenant signers will sign.

```http
POST /v1/policy/{tenant_id}/compose
Authorization: Bearer <token>
Content-Type: application/json

{
  "content": {
    "version": 5,
    "rules": [
      {
        "id": "rule_invoice_under_5k",
        "applies_to": ["outbound_payment"],
        "when": {
          "amount.lte": { "currency": "USD", "value": "5000" },
          "counterparty.in": "vendors.trusted"
        },
        "execute": "auto"
      },
      {
        "id": "rule_invoice_above_5k",
        "applies_to": ["outbound_payment"],
        "when": { "amount.gt": { "currency": "USD", "value": "5000" } },
        "require": "cfo_approval",
        "execute": "confirm"
      }
    ],
    "lists": { "vendors.trusted": ["cp_aws", "cp_gcp"] }
  }
}
```

The `content` wrapper and the numeric `version` are mandatory. An optional top-level `quorum_required` sets how many distinct authorized signers `sign` needs (default `1`).

Response:

```json
{
  "policy_id":       "pol_8231",
  "state":           "pending_signatures",
  "signing_payload": { "domain": {...}, "types": {...}, "message": {...} }
}
```

`execute` is one of `auto | confirm | reject`. These are the rule-level outcomes that produce the policy decision (`allow | confirm | reject`).

### Sign and Activate

Each required signer signs the `signing_payload` from `compose`, then someone (any caller with `policy:sign`) submits the `policy_id` and all signatures together:

```http
POST /v1/policy/{tenant_id}/sign
Authorization: Bearer <token>
Content-Type: application/json

{
  "policy_id": "pol_8231",
  "signatures": [
    { "address": "0xCFO...", "signature": "0x..." },
    { "address": "0xCTO...", "signature": "0x..." }
  ]
}
```

`200 OK` with the serialized policy, an `activated` flag, and any activation `warnings`:

```json
{
  "policy": {
    "id":             "pol_8231",
    "version":        4,
    "state":          "active",
    "content":        { "version": 4, "rules": [...] },
    "content_hash":   "abc123...",
    "signers":        [...],
    "quorum_required": 2,
    "activated_at":   "2026-05-28T12:00:00Z",
    "deactivated_at": null,
    "created_by":     "usr_...",
    "created_at":     "2026-05-28T11:59:00Z"
  },
  "activated": true,
  "warnings":  []
}
```

The signature count reaching `quorum_required` flips the policy to `active` (`activated: true`). Below quorum, the signatures are recorded and the policy stays `pending_signatures`. A signature that fails to verify, a duplicate signer, or a signer that is not an authorized tenant signer returns `401` with `policy_signature_invalid`. Signing a policy that is not awaiting signatures returns `409` with `policy_quorum_not_met`.

### Get the Active Policy

```http
GET /v1/policy/{tenant_id}
Authorization: Bearer <token>
```

Returns the currently active `Policy` for the tenant (`404` if none has been activated). For a specific historical version, use `/versions`.

### List Versions

```http
GET /v1/policy/{tenant_id}/versions
Authorization: Bearer <token>
```

```json
{
  "versions": [
    {
      "id": "pol_8231",
      "version": 4,
      "content_hash": "0xabc...",
      "activated_at": "2026-05-28T...",
      "deactivated_at": null
    },
    {
      "id": "pol_5417",
      "version": 3,
      "content_hash": "0x111...",
      "activated_at": "2026-03-01T...",
      "deactivated_at": "2026-05-28T..."
    }
  ]
}
```

### Evaluate an Action

Dry-run an action against the active policy. This is the same evaluator the §6 pre-execution gate uses internally; it does **not** propose, reserve, or audit. It just returns the decision.

```http
POST /v1/policy/{tenant_id}/evaluate
Authorization: Bearer <token>
Content-Type: application/json

{
  "action": {
    "kind":            "outbound_payment",
    "counterparty_id": "cp_aws",
    "amount":          { "currency": "USD", "value": "7800" }
  }
}
```

```json
{
  "outcome": "confirm",
  "matched_rule_id": "rule_invoice_above_5k",
  "required_approvers": ["cfo"],
  "trace": [
    {
      "rule_id": "rule_invoice_under_5k",
      "matched": false,
      "checks": [{ "key": "amount.lte", "passed": false, "detail": "USD 5000" }]
    },
    {
      "rule_id": "rule_invoice_above_5k",
      "matched": true,
      "checks": [{ "key": "amount.gt", "passed": true, "detail": "USD 5000" }]
    }
  ]
}
```

### Three Possible Decisions

| Decision  | Meaning                                                                               |
| --------- | ------------------------------------------------------------------------------------- |
| `allow`   | Rule matched with `execute: "auto"`; action can proceed straight to the §6 gate       |
| `confirm` | Rule matched with `execute: "confirm"`; named `required_approvers` must sign first    |
| `reject`  | Rule matched with `execute: "reject"`, or no rule matched the default-deny vocabulary |

Casing is **lowercase**. `allow | confirm | reject`. The historical-simulation counters mirror it (`would_allow`, `would_confirm`, `would_reject`).

#### Decision vocabulary across surfaces

`allow | confirm | reject` is the canonical protocol decision. The rule-level `execute` field and the SDK use aliases that map 1:1; the PaymentIntent status reflects the same outcome:

| Protocol decision (HTTP/MCP) | Rule-level `execute` | SDK `decision.outcome` / `action.status` | Resulting PaymentIntent status |
| ---------------------------- | -------------------- | ---------------------------------------- | ------------------------------ |
| `allow`                      | `auto`               | `auto`                                   | `approved`                     |
| `confirm`                    | `confirm`            | `needs_approval`                         | `pending_approval`             |
| `reject`                     | `reject`             | `rejected`                               | `rejected`                     |

Compare against `allow | confirm | reject` over HTTP/MCP; the `auto | needs_approval | rejected` triple is an SDK alias, not the protocol vocabulary.

### Action Vocabulary

The evaluate `action.kind` is one of the following. There is no `rail` field on the evaluate action.

| `kind`             | Domain                                            |
| ------------------ | ------------------------------------------------- |
| `outbound_payment` | Money leaving (ACH, wire, on-chain, x402, escrow) |
| `inbound_payment`  | Money arriving                                    |
| `ledger_write`     | A Ledger-row mutation (e.g. agent normalization)  |
| `onchain_tx`       | A non-payment on-chain transaction                |
| `agent_action`     | A non-money agent action gated by policy          |
| `any`              | Only valid inside a rule's `applies_to` catch-all |

A rule's `applies_to` accepts the same `kind` values, including `any`. (The PaymentIntent layer uses a separate, broader `action_type` set. `ach_outbound`, `wire`, `x402_settle`, etc.. Those map onto the `kind` values internally.)

### Lint a Draft

Before composing, run a linter against a policy-content blob to catch shape / semantic problems:

```http
POST /v1/policy/{tenant_id}/lint
Authorization: Bearer <token>
Content-Type: application/json

{ "policy_content": { "rules": [...] } }
```

```json
{
  "tenant_id": "acme",
  "errors": 0,
  "warnings": 2,
  "findings": [
    {
      "code": "rule_amount_currency_missing",
      "severity": "WARN",
      "rule_id": "rule_3",
      "message": "amount.gt without explicit currency"
    }
  ]
}
```

### Simulate Against a Version

Replay a single action against a specific historical policy version:

```http
POST /v1/policy/{tenant_id}/simulate
Authorization: Bearer <token>
Content-Type: application/json

{
  "action":  { "kind": "outbound_payment", "counterparty_id": "cp_aws", "amount": { "currency": "USD", "value": "7800" } },
  "version": 3
}
```

Returns `{ "decision": <same shape as /evaluate>, "policy_version": 3 }`. Unlike `/evaluate`, simulate wraps the decision with the `policy_version` it replayed against.

### Replay a Period

Replay every action in a time window against a candidate (unsigned) policy. Useful for asking "would version 5 have changed anything?":

```http
POST /v1/policy/{tenant_id}/simulate-historical
Authorization: Bearer <token>
Content-Type: application/json

{
  "policy_content": { "rules": [...] },
  "period_start":   "2026-01-01",
  "period_end":     "2026-04-30"
}
```

```json
{
  "total": 4127,
  "would_allow": 3902,
  "would_confirm": 201,
  "would_reject": 24,
  "diff_vs_active": { "newly_rejected": 7, "newly_confirmed": 14, "loosened": 0 }
}
```

### Diff Two Versions

```http
POST /v1/policy/{tenant_id}/diff
Authorization: Bearer <token>
Content-Type: application/json

{ "from_version": 3, "to_version": 4 }
```

```json
{
  "from_version": 3,
  "to_version": 4,
  "added": ["rule_x402_micropayment_cap"],
  "removed": [],
  "modified": [
    {
      "rule_id": "rule_invoice_above_5k",
      "field": "require",
      "before": null,
      "after": "cfo_approval"
    }
  ]
}
```

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📋 Policy and Permissioning</strong></td><td>The conceptual model.</td><td><a href="../protocol/policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>📜 BrainPolicyRegistry</strong></td><td>The on-chain registry.</td><td><a href="../smart-contracts/brainpolicyregistry.md">brainpolicyregistry.md</a></td><td></td></tr></tbody></table>
