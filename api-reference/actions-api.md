# Actions API

Propose, approve, and execute actions. Every action passes through the policy engine and emits an audit trail.

### Propose an Action

```http
POST /v1/agents/{agent_id}/propose
Authorization: Bearer <agent or tenant token>
Content-Type: application/json

{
  "tenantId": "acme",
  "action": {
    "type":      "pay_invoice",
    "invoiceId": "inv_8231",
    "amount":    "7800_000000",
    "asset":     "USDC"
  }
}
```

Response:

```json
{
  "actionId":         "act_...",
  "decision":         "ESCALATE",
  "reason":           "amount_above_threshold",
  "policy_version":   3,
  "approvers":        ["role:cfo"],
  "wiki_context": {
    "vendor_history":   "Vendor X: known, status=approved, 14 prior payments",
    "ledger_refs":      ["ledger_71022", "ledger_71023"]
  },
  "signed_verdict":   null,
  "audit_event_id":   "audit_evt_..."
}
```

### Decisions

| Decision   | What Happens                                                                       |
| ---------- | ---------------------------------------------------------------------------------- |
| `ALLOW`    | A `signed_verdict` is included; the action can execute immediately (60-second TTL) |
| `ESCALATE` | The action is in pending state; named approvers must sign                          |
| `DENY`     | The action will not execute; `reason` carries the structured cause                 |

### Get an Action

```http
GET /v1/actions/{action_id}
Authorization: Bearer <token>
```

Response:

```json
{
  "id":              "act_...",
  "agent_id":        "ag_...",
  "tenantId":        "acme",
  "type":            "pay_invoice",
  "decision":        "ESCALATE",
  "approvers":       ["role:cfo"],
  "approvals":       [],
  "executed_at":     null,
  "audit_events": [
    "audit_evt_proposed_...",
    "audit_evt_evaluated_..."
  ]
}
```

### Approve an Escalated Action

The named approver signs an EIP-712 approval and submits it.

```http
POST /v1/actions/{action_id}/approve
Authorization: Bearer <tenant token>
Content-Type: application/json

{
  "approver_role": "cfo",
  "signature":     "0x..."
}
```

Response:

```json
{
  "actionId":      "act_...",
  "decision":      "ALLOW",
  "approvals":     [{ "role": "cfo", "signed_at": "..." }],
  "signed_verdict":"0x...",
  "expires_at":    "2025-09-01T12:01:00Z"
}
```

Multiple approvers may be required (`2-of-3` thresholds, etc). The action remains pending until all required approvals are collected.

### Execute an Approved Action

```http
POST /v1/actions/{action_id}/execute
Authorization: Bearer <token>
```

Response:

```json
{
  "actionId":       "act_...",
  "rail":           "smart_account",
  "tx_hash":        "0xabc...",
  "settled_at":     "2025-09-01T...",
  "audit_event_id": "audit_evt_executed_..."
}
```

| Rail            | Description                                    |
| --------------- | ---------------------------------------------- |
| `bank_api`      | Off-chain rail (bank API or processor)         |
| `smart_account` | On-chain via `BrainSmartAccount` UserOperation |
| `x402`          | HTTP-native machine settlement                 |

### Subscribe to Action Events

```
WSS /v1/actions/{action_id}/events
Authorization: Bearer <token>
```

Event types: `proposed`, `policy.evaluated`, `escalated`, `approved`, `denied`, `executing`, `executed`, `failed`.

### List Actions

```http
GET /v1/actions?tenantId=acme&decision=ESCALATE&limit=50
Authorization: Bearer <token>
```

Filters: `tenantId`, `agent_id`, `decision`, `type`, `from`, `to`, `cursor`, `limit`.

### Cancel a Pending Action

If an action is in ESCALATE state and has not yet been approved or denied:

```http
DELETE /v1/actions/{action_id}
Authorization: Bearer <tenant token>
```

The action is marked `cancelled`. An audit event records the cancellation.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📜 Audit API</strong></td><td>Pull proofs for executed actions.</td><td><a href="audit-api.md">audit-api.md</a></td><td></td></tr><tr><td><strong>🤖 Agents API</strong></td><td>Register agents and grant scope.</td><td><a href="agents-api.md">agents-api.md</a></td><td></td></tr></tbody></table>
