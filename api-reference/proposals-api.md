# Proposals API

Non-financial agent outputs (vendor risk, collections, treasury, cash forecast, dispute, compliance, revenue intel, reconciliation, subscription, fraud anomaly) that a human reviews and decides on. See [Proposals](../protocol/proposals.md) for the concept and state machine. This is a separate surface from the [Payment Intents API](payment-intents-api.md), which moves money.

| Operation | Endpoint                         | Scope             |
| --------- | -------------------------------- | ----------------- |
| List      | `GET  /v1/proposals`             | `execution:read`  |
| Get       | `GET  /v1/proposals/{id}`        | `execution:read`  |
| Decide    | `POST /v1/proposals/{id}/decide` | `execution:admin` |

### List Proposals

```http
GET /v1/proposals?status=needs_review&type=vendor_risk
Authorization: Bearer <token>
```

Optional query params: `status` (`needs_review | acknowledged | approved | rejected | undone_to_review`), `type` (one of the 11 proposal types), `limit` (default 50, max 500). An unrecognized `status` or `type` returns `400 request_params_invalid`.

```json
{
  "proposals": [
    {
      "id": "agpr_01H...",
      "type": "vendor_risk",
      "agent_principal": "agent_01H...",
      "risk_band": "elevated",
      "status": "needs_review",
      "title": "Elevated exposure: Datacenter Hosting Ltd invoice nears monthly ceiling",
      "amount": "187000.00",
      "created_at": "2026-01-01T00:00:00Z"
    }
  ]
}
```

### Get a Proposal

```http
GET /v1/proposals/{id}
Authorization: Bearer <token>
```

Returns the full `AgentProposal` shape (summary fields plus `execution_mode`, `narrative`, `evidence`, `links`, `policy_decision_id`, `confidence`, `reversible`, `decision`, `decided_by`, `decided_at`). `404 agent_proposal_not_found` if unknown or tenant-isolated.

### Decide a Proposal

```http
POST /v1/proposals/{id}/decide
Authorization: Bearer <token>
Content-Type: application/json

{ "decision": "approved" }
```

`decision` is required: `approved | rejected | acknowledged | undone_to_review`. An optional `edit` object may carry field overrides (e.g. `{"amount": "1500.00"}`) recorded alongside the decision. The actor resolves through `ActorResolver` to a tenant member; a session principal that is not `principal_type=user` (an agent token) is refused with `403 payment_intent_approval_invalid` / `actor_unresolved`, mirroring PaymentIntent approval.

Legal transitions are gated by the proposal's `execution_mode` and `reversible` flag, see [Proposals → State Machine](../protocol/proposals.md#state-machine). Any other decision for the proposal's current state returns:

```json
{
  "error": {
    "code": "agent_proposal_invalid_state",
    "message": "invalid agent proposal transition needs_review + acknowledged"
  }
}
```

`409 agent_proposal_invalid_state` also covers a lost compare-and-swap race (the row changed status between two concurrent decide calls).

Every decision emits an `audit_events` row: `action: "proposal.decided"`.

### `expand=agent` on Payment Intents

`GET /v1/payment-intents/{id}` accepts an `expand=agent` query param that attaches the creating agent (`{id, display_name, kind, role, state}`, or `null` if `created_by_agent_id` is null or the lookup misses). The response is unchanged when the param is absent. See the [Payment Intents API](payment-intents-api.md).

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>💵 Payment Intents API</strong></td><td>The gated money-movement path.</td><td><a href="payment-intents-api.md">payment-intents-api.md</a></td><td></td></tr><tr><td><strong>🤖 Agents API</strong></td><td>Register agents, route events, run agents.</td><td><a href="agents-api.md">agents-api.md</a></td><td></td></tr></tbody></table>
