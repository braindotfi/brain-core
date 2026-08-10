# Proposals Read Model Contract

`GET /v1/proposals` and `GET /v1/proposals/{id}` expose one tenant-scoped read
model over Ledger payment intents and non-financial agent proposals. The compact
fields are retained for existing clients. New clients should use `details`,
`policy`, `presentation`, and `available_decisions` for rich cards.

## Public Types

The public `type` field is one of:

| Type                | Source                                                                                      | Action set                   |
| ------------------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| `bill_management`   | Bill Management advisory proposals and its payment intent rows when created by that agent   | Approve, Reject              |
| `cash_forecast`     | Cash Forecasting advisory proposals                                                         | Approve, Reject              |
| `collections`       | Collections follow-up, task, escalation, and payment-plan proposals                         | Approve, Reject              |
| `compliance`        | Compliance notifications and policy-violation findings                                      | Acknowledge                  |
| `debt_optimization` | Debt Optimization advisory proposals and its payment intent rows when created by that agent | Approve, Reject              |
| `dispute`           | Dispute evidence, response, escalation, and packet proposals                                | Proceed, Dismiss             |
| `financial_health`  | Financial Health advisory proposals                                                         | Approve, Reject              |
| `fraud_anomaly`     | Fraud and anomaly findings. Background-triggered `flag_transaction` rows are notify-only.   | Acknowledge for trigger rows |
| `payment`           | Payment agent proposals and payment intents without a more specific public agent role       | Approve, Reject              |
| `personal_budget`   | Personal Budget advisory proposals                                                          | Approve, Reject              |
| `purchase_advisor`  | Purchase Advisor advisory proposals                                                         | Approve, Reject              |
| `reconciliation`    | Reconciliation match proposals and discrepancy reviews                                      | Accept match, Reject match   |
| `revenue_intel`     | Revenue Intelligence follow-up, churn, expansion, and summary proposals                     | Approve, Reject              |
| `savings`           | Savings advisory proposals and its payment intent rows when created by that agent           | Approve, Reject              |
| `subscription`      | Subscription detection, cancel, vendor-email, and savings report proposals                  | Approve, Reject              |
| `tax_prep`          | Tax Prep tagging, summary, missing-evidence, and export proposals                           | Approve, Reject              |
| `travel_finance`    | Travel Finance card, fee, trip-spend, and notification proposals                            | Approve, Reject              |
| `treasury`          | Treasury advisory proposals and treasury-created payment intents                            | Approve, Reject              |
| `vendor_risk`       | Vendor Risk holds, verification, and escalation proposals                                   | Clear vendor, Hold vendor    |

Money-moving actions still go through PaymentIntent and the existing policy and
approval rails. When the creating agent has a public role such as `treasury`,
`bill_management`, `debt_optimization`, or `savings`, the read model preserves
that domain as the public `type`; otherwise it falls back to `payment`.

## Response Shape

Each proposal includes the older compact fields:

```json
{
  "id": "prop_...",
  "type": "vendor_risk",
  "created_at": "2026-07-30T00:00:00.000Z",
  "status": "pending",
  "risk_band": "high",
  "confidence": 0.91,
  "mode": "propose",
  "narrative": "Vendor risk increased.",
  "evidence": [{ "kind": "counterparty", "ref": "cp_...", "resolvable": true }],
  "agent": { "id": "agent_...", "kind": "internal", "display_name": "Vendor Risk" },
  "payment_intent_id": null,
  "action_type": null
}
```

The same object now also includes:

| Field                 | Contract                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stored_action_type`  | Original stored action type, for example `flag_transaction`, `block_payment`, or a PaymentIntent `action_type`.                                                                                                                                                                                              |
| `details`             | Backward-compatible pass-through of the stored action fields, or the PaymentIntent Ledger columns shaped as action details. This is the source for per-type fields such as `risk_score`, `ranked_signals`, `finding_type`, `recommended_remediation`, `match_basis`, `recurring_amount`, and domain context. |
| `policy`              | `decision`, `policy_id`, `policy_version`, `matched_rule_id`, `explanation`, `required_approvers`, and raw `trace` when available.                                                                                                                                                                           |
| `presentation`        | Normalized card data: `headline`, `recommendation`, `key_facts`, `confidence_band`, `policy`, `consequences`, `actions`, and six-layer `technical_detail`.                                                                                                                                                   |
| `available_decisions` | The semantic decisions the API can accept through `/v1/proposals/{id}/decide`, with UI labels and meanings.                                                                                                                                                                                                  |

`presentation.technical_detail` has stable layer keys:

| Layer        | Meaning                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `1_ingest`   | Evidence refs and resolved evidence pointers exposed by the read model.                                          |
| `2_extract`  | Stored proposal detail fields.                                                                                   |
| `3_classify` | Public type, stored action type, source kind, and agent kind.                                                    |
| `4_score`    | Risk band, confidence, confidence band, evidence score, risk level, risk score, and ranked signals when present. |
| `5_policy`   | Same policy summary exposed at top level.                                                                        |
| `6_propose`  | Status, mode, recommendation, and available decision ids.                                                        |

`superseded` is a terminal status. It marks an unresolved proposal replaced by
a newer proposal for the same underlying entity. Clients must not present a
decision control for a superseded proposal.

## Type Mapping

The read model resolves public type deterministically:

1. If the stored action type is already a public type, use it.
2. Otherwise use the agent role or agent kind from stored action fields or the
   joined agent row.
3. Otherwise use the explicit stored-action map. Examples:
   `flag_transaction -> fraud_anomaly`, `block_payment -> vendor_risk`,
   `propose_match -> reconciliation`, `recommend_card -> travel_finance`,
   `tag_tax_item -> tax_prep`, and `recommend_savings_transfer -> savings`.

Ambiguous action names such as `notify`, `escalate`, `create_task`, and
`recommend_action` resolve through the agent role. They are not guessed from
the action name alone.

## Evidence And Wiki Page Types

Evidence refs are tagged with a `kind` and `resolvable` flag. Today the
resolvable Wiki or Ledger kinds are `account`, `counterparty`, `invoice`,
`obligation`, `transaction`, and `wiki_entity`. Proposal details may also carry
domain refs such as `dispute`, `subscription`, `policy_decision`, `audit_event`,
`goal`, `budget`, and `trip`; these are exposed in `details` and
`technical_detail` even when the generic evidence resolver cannot deep-link them
yet.

## Policy Notes

Compliance proposals are notify-only by default. Acknowledge marks the finding as
acknowledged and does not unblock an original blocked action.

Fraud Anomaly background triggers such as `transaction.unusual`,
`merchant.risk_detected`, and `duplicate_charge.detected` create
`flag_transaction` proposals with `mode: "notify_only"`. Those proposals expose
only `available_decisions: [{ id: "acknowledge", ... }]` through the public read
model, even when `details.recommended_action` is `hold` or `review`. The
recommendation is informational for those rows and is not an executable hold or
block decision.

The read model still defines Mark reviewed and Hold transaction labels for
propose-mode `fraud_anomaly` rows. Those labels apply only when a stored fraud
proposal is actually in `mode: "propose"`; they are not available on
background-triggered `flag_transaction` findings.

Vendor Risk uses domain labels for its propose-mode decisions, but the write
route remains `approve`, `reject`, `acknowledge`, or `undo` for compatibility.
