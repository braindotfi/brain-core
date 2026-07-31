---
description: Read agent proposals, record a human decision, and resolve proposal evidence.
---

# Proposals and Evidence API

The Proposals API is the customer-facing surface over everything Brain's agents
produce. It unifies money-path payment intents and non-money agent findings into
one tenant-scoped, cursor-paginated feed, lets a human decide on any one of them,
and resolves the typed evidence a proposal cites into readable summaries.

This is the read-and-decide half of the agent loop. Agents propose through the
gated agent path; humans list, inspect, and decide here.

| Operation                 | Endpoint                         | Scope                                                                           |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| List proposals            | `GET  /v1/proposals`             | `execution:read`                                                                |
| Get one proposal          | `GET  /v1/proposals/{id}`        | `execution:read`                                                                |
| Decide on a proposal      | `POST /v1/proposals/{id}/decide` | `execution:read` or `payment_intent:approve`, plus member authority (see below) |
| Resolve proposal evidence | `POST /v1/evidence/resolve`      | `execution:read`                                                                |

{% hint style="info" %}
The same read model and decision service back the MCP tools `proposals.list`,
`proposals.get`, `proposals.decide`, and `evidence.resolve`. HTTP and MCP share
one code path, so tenant scoping, actor resolution, member authority, and the
money-path approval gates behave identically on both. See
[MCP Tools](../mcp-server/tools.md).
{% endhint %}

## List Proposals

```http
GET /v1/proposals?type=collections&status=pending_approval&limit=25
Authorization: Bearer <tenant token>
```

Tenant-scoped and cursor-paginated. Every filter is optional.

| Query parameter  | Type    | Description                                                             |
| ---------------- | ------- | ----------------------------------------------------------------------- |
| `type`           | string  | One of the public proposal types (see below).                           |
| `status`         | string  | Lifecycle status filter (see below).                                    |
| `risk_band`      | string  | `low`, `standard`, `elevated`, or `high`.                               |
| `min_confidence` | number  | Float in `[0, 1]`. Returns proposals at or above this agent confidence. |
| `limit`          | integer | Page size, `1` to `100`.                                                |
| `cursor`         | string  | Opaque pagination cursor from a prior response's `next_cursor`.         |

### Response

```json
{
  "proposals": [
    {
      "id": "prop_9f2a...",
      "type": "collections",
      "created_at": "2026-07-20T14:03:11Z",
      "status": "pending_approval",
      "risk_band": "standard",
      "confidence": 0.82,
      "mode": "propose",
      "narrative": "Invoice INV-2231 is 34 days overdue. Recommend a second-notice follow-up.",
      "evidence": [
        { "kind": "invoice", "ref": "inv_2231", "resolvable": true },
        { "kind": "counterparty", "ref": "cp_88", "resolvable": true }
      ],
      "agent": { "id": "agt_collections", "kind": "collections", "display_name": "Collections" },
      "payment_intent_id": null,
      "action_type": null,
      "stored_action_type": "draft_followup",
      "details": {
        "invoice_id": "inv_2231",
        "counterparty_id": "cp_88",
        "days_overdue": 34,
        "recommended_tone": "firm"
      },
      "policy": {
        "decision": "confirm",
        "policy_id": "pol_8231",
        "policy_version": 4,
        "matched_rule_id": "default-agent-action-requires-review",
        "explanation": "Collections follow-up requires human confirmation.",
        "required_approvers": ["signer"],
        "trace": []
      },
      "presentation": {
        "headline": "Follow up on overdue invoice INV-2231.",
        "recommendation": "Send a second-notice collections follow-up.",
        "key_facts": [
          { "label": "Invoice", "value": "INV-2231" },
          { "label": "Days overdue", "value": 34 }
        ],
        "confidence_band": "high",
        "policy": {
          "decision": "confirm",
          "policy_id": "pol_8231",
          "policy_version": 4,
          "matched_rule_id": "default-agent-action-requires-review",
          "explanation": "Collections follow-up requires human confirmation.",
          "required_approvers": ["signer"],
          "trace": []
        },
        "consequences": {
          "approve": "Brain records the human approval and lets the internal workflow continue.",
          "reject": "Brain closes the proposal without continuing the workflow.",
          "acknowledge": null
        },
        "actions": [
          {
            "id": "approve",
            "label": "Approve",
            "meaning": "Approve this proposed action."
          },
          {
            "id": "reject",
            "label": "Reject",
            "meaning": "Reject this proposed action."
          }
        ],
        "technical_detail": {
          "1_ingest": { "evidence": [{ "kind": "invoice", "ref": "inv_2231" }] },
          "2_extract": { "days_overdue": 34 },
          "3_classify": { "type": "collections", "stored_action_type": "draft_followup" },
          "4_score": { "confidence": 0.82, "confidence_band": "high" },
          "5_policy": {
            "decision": "confirm",
            "policy_id": "pol_8231",
            "policy_version": 4,
            "matched_rule_id": "default-agent-action-requires-review",
            "explanation": "Collections follow-up requires human confirmation.",
            "required_approvers": ["signer"],
            "trace": []
          },
          "6_propose": { "status": "pending_approval", "mode": "propose" }
        }
      },
      "available_decisions": [
        {
          "id": "approve",
          "label": "Approve",
          "meaning": "Approve this proposed action."
        },
        {
          "id": "reject",
          "label": "Reject",
          "meaning": "Reject this proposed action."
        }
      ]
    }
  ],
  "next_cursor": "eyJvIjoxMjV9"
}
```

`next_cursor` is `null` on the last page. A money-path proposal carries a
`payment_intent_id` and `action_type`; a non-money finding leaves both `null`.
`confidence` and `risk_band` are `null` when the agent did not score them.

The compact fields remain stable for existing clients. The read model also
returns the additive fields below for rich proposal cards:

| Field                 | Description                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stored_action_type`  | Original stored action type, for example `flag_transaction`, `block_payment`, `draft_followup`, or a PaymentIntent `action_type`.                    |
| `details`             | Stored action fields or PaymentIntent Ledger columns shaped as proposal details. Common keys include `risk_score`, `ranked_signals`, and entity ids. |
| `policy`              | Policy decision summary: `decision`, `policy_id`, `policy_version`, `matched_rule_id`, `explanation`, `required_approvers`, and `trace`.             |
| `presentation`        | Normalized UI card data: `headline`, `recommendation`, `key_facts`, `confidence_band`, `policy`, `consequences`, `actions`, and technical detail.    |
| `available_decisions` | Semantic decisions accepted by `POST /v1/proposals/{id}/decide`, with labels and meanings for the current proposal type.                             |

`presentation.technical_detail` always uses the six stable layer keys
`1_ingest`, `2_extract`, `3_classify`, `4_score`, `5_policy`, and `6_propose`.

### Public proposal types

`vendor_risk`, `payment`, `collections`, `treasury`, `cash_forecast`, `dispute`,
`compliance`, `revenue_intel`, `reconciliation`, `subscription`,
`fraud_anomaly`, `personal_budget`, `financial_health`, `purchase_advisor`,
`tax_prep`, `travel_finance`, `bill_management`, `debt_optimization`,
`savings`.

The public `type` is resolved deterministically:

1. A stored action type that is already a public proposal type is used directly.
2. Otherwise Brain uses the agent role or agent kind from the stored action or
   joined agent row.
3. Otherwise Brain uses the explicit stored-action map. Examples:
   `flag_transaction -> fraud_anomaly`, `block_payment -> vendor_risk`,
   `propose_match -> reconciliation`, `recommend_card -> travel_finance`,
   `tag_tax_item -> tax_prep`, `remind -> bill_management`, and
   `recommend_savings_transfer -> savings`.

Ambiguous stored action names such as `notify`, `escalate`, `create_task`, and
`recommend_action` resolve through the agent role. Brain does not guess their
public type from the action name alone.

This expansion is backward-compatible. No new API version or route was
introduced because all compact fields remain in place and the richer fields are
additive.

### Lifecycle status values

`proposed`, `pending`, `pending_approval`, `awaiting_second_approval`,
`approved`, `acknowledged`, `reconciling`, `paused`, `dispatching`, `rejected`,
`executed`, `failed`, `cancelled`, `undone`, `unknown`.

## Get One Proposal

```http
GET /v1/proposals/{id}
Authorization: Bearer <tenant token>
```

Returns the same object shape as a list item. An unknown or cross-tenant id
returns `404 execution_proposal_not_found`; the read is tenant-scoped, so a
proposal from another tenant is indistinguishable from one that does not exist.

## Decide on a Proposal

```http
POST /v1/proposals/{id}/decide
Authorization: Bearer <member session token>
Content-Type: application/json

{ "decision": "approve" }
```

`decision` is one of `approve`, `reject`, `acknowledge`, or `undo`.

{% hint style="warning" %}
**A decision is a human authority action, not a token-scope action.** The route
accepts `execution:read` or `payment_intent:approve`, but it then resolves the
caller through the same `ProposalDecisionService` as every other approval
surface. The actor must be a **user-principal, active tenant member with
approval authority**. Agent principals are rejected with `actor_unresolved`; a
propose-only agent token can read proposals but can never decide one.
{% endhint %}

Approving a money-path proposal runs the full money-path authority gate, in
order: active tenant member, admin or approver role, authorized approval domain,
per-item limit, actor is not the payee (self-approval block), and a tenant-wide
distinct second approver where the policy requires one. A first valid approval on
a proposal that needs two moves it to `awaiting_second_approval`; a distinct
second member's approval clears it for dispatch. The same member approving twice
returns `second_approval_required`. Every decision is written to the Audit log
before any status transition.

`acknowledge` records that a human saw a non-money finding without acting.
`reject` closes a proposal. `undo` reverses an eligible prior decision. There is
no execute call here or anywhere on the API: approval authorizes Brain's internal
settlement path, it does not dispatch the rail itself.

## Resolve Proposal Evidence

Proposals cite evidence as typed `{ kind, ref }` pairs. This endpoint turns those
refs into tenant-scoped summaries and deep links, so a UI can render what a
proposal is standing on without knowing each ref format.

```http
POST /v1/evidence/resolve
Authorization: Bearer <tenant token>
Content-Type: application/json

{
  "refs": [
    { "kind": "invoice", "ref": "inv_2231" },
    { "kind": "counterparty", "ref": "cp_88" }
  ]
}
```

At most **50** refs per call. Response:

```json
{
  "results": [
    {
      "kind": "invoice",
      "ref": "inv_2231",
      "resolvable": true,
      "not_found": false,
      "summary": "INV-2231, 4,200.00 USD, due 2026-06-16, 34 days overdue",
      "deep_link": "/invoices/inv_2231"
    },
    {
      "kind": "agent",
      "ref": "agt_collections",
      "resolvable": false,
      "not_found": false,
      "summary": null,
      "deep_link": null,
      "reason": "unsupported_kind"
    }
  ]
}
```

Resolution fails closed and is tenant-scoped. A supported ref that does not
exist in the tenant returns `resolvable: true, not_found: true`. An unsupported
kind or malformed ref returns `resolvable: false` with a `reason` of
`unsupported_kind` or `malformed_ref`; it is never an error.

**Resolvable kinds:** `account`, `counterparty`, `invoice`, `obligation`,
`transaction`, `wiki_entity`. Other evidence kinds a proposal may cite (for
example `document`, `payment_intent`, `policy`, `raw_artifact`) are returned
unresolved today rather than rejected, so a mixed evidence list always resolves
partially instead of failing whole.

## Related

| Topic                      | Page                                              |
| -------------------------- | ------------------------------------------------- |
| How agents run and propose | [Agents API](agents-api.md)                       |
| The money-path proposal    | [Payment Intents API](payment-intents-api.md)     |
| The same tools over MCP    | [MCP Tools](../mcp-server/tools.md)               |
| Who may approve            | [Internal Agents](../concepts/internal-agents.md) |
