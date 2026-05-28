# Payment Intents API

The canonical Brain HTTP surface for proposing, approving, and executing financial actions is the **PaymentIntent** family. The `agent_id`-keyed proposal route from earlier drafts (`POST /v1/agents/{agent_id}/propose`) and the `/v1/actions/*` paths are **not implemented**. Both are documented as deprecated stubs in the spec and return 404. Use the routes below.

| Operation              | Endpoint                                             |
| ---------------------- | ---------------------------------------------------- |
| Create (propose)       | `POST /v1/payment-intents`                           |
| Get                    | `GET  /v1/payment-intents/{id}`                      |
| Approve (confirm-mode) | `POST /v1/payment-intents/{id}/approve`              |
| Reject                 | `POST /v1/payment-intents/{id}/reject`               |
| Execute (gated)        | `POST /v1/payment-intents/{id}/execute`              |
| Pause / Resume         | `POST /v1/payment-intents/{id}/{pause,resume}`       |
| Replay-investigation   | `GET  /v1/payment-intents/{id}/replay-investigation` |
| Agent-driven full run  | `POST /v1/agents/run` (see Agents API)               |

### Propose a Payment

```http
POST /v1/payment-intents
Authorization: Bearer <token>
Content-Type: application/json

{
  "action_type":                "ach_outbound",
  "source_account_id":          "acct_ops",
  "destination_counterparty_id": "cp_aws",
  "amount":                     "7800.00",
  "currency":                   "USD",
  "invoice_id":                 "inv_8231",
  "evidence_ids":               ["rp_001"]
}
```

`action_type` is one of `ach_outbound | ach_inbound | wire | onchain_transfer | erp_writeback | card_payment | x402_settle | escrow_release`. `amount` is a decimal string. `currency` matches `^[A-Z]{3}$|^USDC$`.

For the special invoice shortcut (resolves amount / currency / counterparty / source / evidence from a Ledger invoice):

```json
{ "type": "pay_invoice", "invoice_id": "inv_8231" }
```

Response (`201 Created`) is a full PaymentIntent with a PolicyDecision already attached:

```json
{
  "id": "pi_a1b2c3",
  "owner_id": "acme",
  "created_by_agent_id": "ag_payment_v1",
  "action_type": "ach_outbound",
  "source_account_id": "acct_ops",
  "destination_counterparty_id": "cp_aws",
  "amount": "7800.00",
  "currency": "USD",
  "invoice_id": "inv_8231",
  "status": "pending_approval",
  "policy_decision_id": "pd_7331",
  "approval_ids": [],
  "execution_receipt_ids": []
}
```

Errors: `400`, `403`, `404` (invoice not found / not accessible), `409` (invoice already paid / `agent_proposal_duplicate`), `422`.

### Get a PaymentIntent

```http
GET /v1/payment-intents/{id}
Authorization: Bearer <token>
```

Returns the same `PaymentIntent` shape as above. `404` if unknown or tenant-isolated.

### Status Lifecycle

| Status             | Meaning                                                       |
| ------------------ | ------------------------------------------------------------- |
| `proposed`         | Created; Policy is evaluating                                 |
| `pending_approval` | Policy returned `confirm`; awaiting approver signatures       |
| `approved`         | All required approvals collected (or Policy returned `allow`) |
| `rejected`         | Policy returned `reject`, or an approver rejected             |
| `executed`         | Rail dispatch succeeded                                       |
| `failed`           | §6 gate failed or rail dispatch errored                       |
| `cancelled`        | Cancelled before approval, or from `paused → cancelled`       |

Plus three transient states surfaced only by the immediate `execute` response: `dispatching`, `dispatched`, `in_flight` (outbox-row states; settlement is async).

### Approve a `pending_approval` Intent

```http
POST /v1/payment-intents/{id}/approve
Authorization: Bearer <approver token>
```

No request body. Returns `200` with the updated `PaymentIntent`. Approvers are determined by Policy (the `confirm` rule's `required_approvers` / quorum); each approver hits this endpoint independently and the intent flips to `approved` once the quorum is met.

### Reject

```http
POST /v1/payment-intents/{id}/reject
Authorization: Bearer <approver token>
Content-Type: application/json

{ "reason": "Vendor on internal hold pending PO reconciliation" }
```

`reason` is optional (≤ 500 chars). Returns `200` with the rejected `PaymentIntent`.

### Execute an Approved Intent

```http
POST /v1/payment-intents/{id}/execute
Authorization: Bearer <token>
```

No request body. Runs the deterministic §6 pre-execution gate against live Ledger state, then atomically transitions the intent `approved → dispatching` and enqueues a `pending` outbox row. The outbox worker dispatches the rail and settles asynchronously.

`202 Accepted`:

```json
{
  "payment_intent_id": "pi_a1b2c3",
  "outbox_id": "ob_001",
  "execution_id": null,
  "rail": "bank_ach",
  "status": "dispatching"
}
```

`execution_id` is `null` on this immediate response and populated when the worker picks the row up. Settlement notifications arrive via the rail-specific webhook (e.g. Plaid `TRANSFER_EVENTS_UPDATE`).

A gate failure returns `409` with `payment_intent_gate_failed` and `details` naming the failing check (see Errors → Pre-execution gate failures).

### Rails

The `rail` returned on `execute` is **not** the same vocabulary as the create-time `action_type`. The mapping:

| `rail`          | Implementation                                                                               |
| --------------- | -------------------------------------------------------------------------------------------- |
| `bank_ach`      | Plaid Transfer (authorize → create; settled async via webhook)                               |
| `onchain_base`  | `BrainSmartAccount.executeViaSessionKey` (Base)                                              |
| `erp_writeback` | NetSuite SuiteTalk (fail-closed stub)                                                        |
| `x402_base`     | USDC-on-Base settlement (mapped from `x402_settle`; unregistered at boot, fail-closed)       |
| `escrow_base`   | `BrainEscrow` lock release (mapped from `escrow_release`; unregistered at boot, fail-closed) |
| `notification`  | Surface-to-human (no money path)                                                             |

The `x402_base` and `escrow_base` rails are **shadow-first**: they throw rather than fake-settle until promoted.

### Pause / Resume (Kill-Switch)

An `approved` intent can be held without a terminal transition, then released:

```http
POST /v1/payment-intents/{id}/pause      # approved → paused
POST /v1/payment-intents/{id}/resume     # paused → approved (re-runs the live §6 gate)
```

No request body for either. Resume re-evaluates the §6 gate against the **current** Ledger state. Defending against drift while paused. And returns `409` if any check now fails.

A halted agent (`POST /v1/agents/{agent_id}/halt`) pauses every one of its in-flight intents at once.

### Replay Investigation

```http
GET /v1/payment-intents/{id}/replay-investigation
Authorization: Bearer <token>
```

Typed forensic record. The intent, each execution (with its typed rail receipt), and the linking ids you'd join to reconstruct exactly what happened:

```json
{
  "payment_intent":     { "id": "pi_a1b2c3", "status": "executed", ... },
  "executions":         [ { "id": "ex_4711", "rail": "bank_ach", "rail_receipt": {...} } ],
  "policy_decision_id": "pd_7331",
  "evidence_ids":       ["rp_001"]
}
```

The policy decision and the audit chain are referenced by id and joined via their owning service APIs (Policy + Audit).

### Agent-Driven Runs

Most agent activity goes through the higher-level run endpoint, which routes → resolves an action → dry-runs the §6 gate → persists an `agent_runs` row → proposes through this same gated path:

```http
POST /v1/agents/run
Authorization: Bearer <token>
Content-Type: application/json

{ "event": "invoice.overdue", "context": { "invoice_id": "inv_8231" } }
```

See the Agents API for the full run / routing / kill-switch surface.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📜 Audit API</strong></td><td>Pull proofs for executed PaymentIntents.</td><td><a href="audit-api.md">audit-api.md</a></td><td></td></tr><tr><td><strong>🤖 Agents API</strong></td><td>Register agents, route events, run agents.</td><td><a href="agents-api.md">agents-api.md</a></td><td></td></tr></tbody></table>
