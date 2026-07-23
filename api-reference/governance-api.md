# Governance API

Review registered agents, change agent lifecycle state, and build audit-derived
governance reports for compliance workflows.

{% hint style="info" %}
These governance routes are staging-only and BFF-only today. They use
`X-Platform-Service-Auth` with the `governance:read` scope, not an end-user
bearer token.
{% endhint %}

| Operation                         | Endpoint                                 |
| --------------------------------- | ---------------------------------------- |
| List registered agents            | `GET /v1/governance/agents`              |
| Get one registered agent          | `GET /v1/governance/agents/{agent_id}`   |
| Pause, resume, or revoke an agent | `PATCH /v1/governance/agents/{agent_id}` |
| Build a governance report         | `GET /v1/governance/reports`             |
| Create a report snapshot          | `POST /v1/governance/reports/snapshot`   |
| Get a report snapshot             | `GET /v1/governance/reports/{report_id}` |

No external agent creation endpoint is exposed. Agents continue to be created
through existing provisioning flows. The policy check catalog is not exposed in
this cycle because it is deferred pending a future security and legal review.

### Authentication

All Governance API routes require the platform service header:

```http
X-Platform-Service-Auth: <secret-with-governance-read>
```

The platform credential must carry `governance:read`.

### List Registered Agents

```http
GET /v1/governance/agents
X-Platform-Service-Auth: <secret-with-governance-read>
```

Query parameters:

| Parameter   | Required | Notes                                                                   |
| ----------- | -------- | ----------------------------------------------------------------------- |
| `tenant_id` | Yes      | Tenant whose agent registry should be listed.                           |
| `status`    | No       | `active`, `pending`, `quarantined`, or `revoked`.                       |
| `owner`     | No       | Phase 1 tenant owner alias. A non-matching value returns an empty list. |
| `limit`     | No       | Default `100`, maximum `500`.                                           |
| `cursor`    | No       | Cursor returned by the previous page.                                   |

```json
{
  "agents": [
    {
      "id": "agent_example",
      "tenant_id": "tnt_example",
      "kind": "internal",
      "role": "finance_ops",
      "display_name": "Finance Ops Agent",
      "status": "active",
      "scopes": null,
      "scope_hash": "abcdef",
      "onchain_address": null,
      "registered_tx": null,
      "registered_at": "2026-07-22T00:00:00.000Z",
      "created_at": "2026-07-22T00:00:00.000Z"
    }
  ],
  "next_cursor": null
}
```

`scopes` is `null` in Phase 1 because the registry stores `scope_hash`, not the
original scope list.

### Get One Registered Agent

```http
GET /v1/governance/agents/agent_example
X-Platform-Service-Auth: <secret-with-governance-read>
```

```json
{
  "agent": {
    "id": "agent_example",
    "tenant_id": "tnt_example",
    "kind": "internal",
    "role": "finance_ops",
    "display_name": "Finance Ops Agent",
    "status": "active",
    "scopes": null,
    "scope_hash": "abcdef",
    "onchain_address": null,
    "registered_tx": null,
    "registered_at": "2026-07-22T00:00:00.000Z",
    "created_at": "2026-07-22T00:00:00.000Z",
    "lifecycle_events": [
      {
        "audit_event_id": "evt_example",
        "actor": "user_admin",
        "action": "governance.agent.lifecycle_changed",
        "policy_decision_id": null,
        "policy_check_id": null,
        "outcome": null,
        "created_at": "2026-07-22T00:00:00.000Z",
        "inputs": { "agent_id": "agent_example", "transition": "pause" },
        "outputs": { "after_state": "quarantined" }
      }
    ]
  }
}
```

### Change Agent Lifecycle

```http
PATCH /v1/governance/agents/agent_example
X-Platform-Service-Auth: <secret-with-governance-read>
Content-Type: application/json

{
  "tenant_id": "tnt_example",
  "transition": "pause",
  "reason": "review requested",
  "actor": "user_admin"
}
```

`transition` is one of `pause`, `resume`, or `revoke`. The route writes
`governance.agent.lifecycle_changed` to the existing audit event store with the
actor and reason.

```json
{
  "agent": {
    "id": "agent_example",
    "tenant_id": "tnt_example",
    "kind": "internal",
    "role": "finance_ops",
    "display_name": "Finance Ops Agent",
    "status": "quarantined",
    "scopes": null,
    "scope_hash": "abcdef",
    "onchain_address": null,
    "registered_tx": null,
    "registered_at": "2026-07-22T00:00:00.000Z",
    "created_at": "2026-07-22T00:00:00.000Z"
  }
}
```

### Build A Governance Report

```http
GET /v1/governance/reports
X-Platform-Service-Auth: <secret-with-governance-read>
```

Query parameters:

| Parameter      | Required | Notes                                         |
| -------------- | -------- | --------------------------------------------- |
| `tenant_id`    | Yes      | Tenant whose audit events should be reported. |
| `period_start` | Yes      | Inclusive report start timestamp.             |
| `period_end`   | Yes      | Exclusive report end timestamp.               |
| `agent_id`     | No       | Filters policy-relevant events to one agent.  |
| `format`       | No       | `json` by default, or `csv`.                  |

Reports include policy-relevant audit events in the requested period. Historical
rows are joined to `policy_decisions` when `policy_decision_id` is present.
`policy_decision_id` is not populated on all historical audit events, so rows
without a native outcome or resolvable policy decision are returned with
`decision_data_status` set to `unavailable` rather than omitted.

```json
{
  "tenant_id": "tnt_example",
  "period_start": "2026-07-01T00:00:00.000Z",
  "period_end": "2026-08-01T00:00:00.000Z",
  "summary": {
    "totals": {
      "proposed": 2,
      "approved": 1,
      "blocked": 0,
      "escalated": 0,
      "decision_data_unavailable": 1
    },
    "coverage": {
      "events": 2,
      "with_policy_decision_id": 1,
      "joined_policy_decision": 1,
      "with_native_outcome": 0
    }
  },
  "events": [
    {
      "audit_event_id": "evt_policy_joined",
      "created_at": "2026-07-22T00:00:00.000Z",
      "actor": "agent_example",
      "agent_id": "agent_example",
      "action": "payment_intent.execute.before",
      "policy_decision_id": "dec_example",
      "policy_check_id": "rule_example",
      "raw_policy_outcome": "allow",
      "outcome": "approved",
      "decision_data_status": "available",
      "unavailable_reason": null
    },
    {
      "audit_event_id": "evt_missing_decision",
      "created_at": "2026-07-22T00:01:00.000Z",
      "actor": "agent_example",
      "agent_id": "agent_example",
      "action": "agent.action.proposed",
      "policy_decision_id": null,
      "policy_check_id": null,
      "raw_policy_outcome": null,
      "outcome": null,
      "decision_data_status": "unavailable",
      "unavailable_reason": "policy_decision_id_missing"
    }
  ]
}
```

The full request and response schema is maintained in
`Brain_API_Specification.yaml`.

### Create A Report Snapshot

```http
POST /v1/governance/reports/snapshot
X-Platform-Service-Auth: <secret-with-governance-read>
Idempotency-Key: <optional-retry-key>
Content-Type: application/json

{ "created_by": "user_admin" }
```

Query parameters:

| Parameter      | Required | Notes                                            |
| -------------- | -------- | ------------------------------------------------ |
| `tenant_id`    | Yes      | Tenant whose audit events should be reported.    |
| `period_start` | Yes      | Inclusive report start timestamp.                |
| `period_end`   | Yes      | Exclusive report end timestamp.                  |
| `agent_id`     | No       | Filters policy-relevant events to one agent.     |
| `format`       | No       | `json` only for snapshots. CSV is not persisted. |

Snapshot creation generates the same JSON `GovernanceReport` as
`GET /v1/governance/reports`, stores that exact payload with its filters, and
returns a `grpt_` report id. The stored payload is immutable.

`Idempotency-Key` is optional. When supplied, a retry with the same key and same
snapshot request returns the original `201` response with the same `report_id`.
Reusing the same key with different snapshot parameters returns `409`.

```json
{
  "report_id": "grpt_example",
  "snapshot": {
    "report_id": "grpt_example",
    "tenant_id": "tnt_example",
    "period_start": "2026-07-01T00:00:00.000Z",
    "period_end": "2026-08-01T00:00:00.000Z",
    "agent_id": null,
    "created_by": "user_admin",
    "created_at": "2026-07-22T00:02:00.000Z",
    "report": {
      "tenant_id": "tnt_example",
      "period_start": "2026-07-01T00:00:00.000Z",
      "period_end": "2026-08-01T00:00:00.000Z",
      "summary": {
        "totals": {
          "proposed": 2,
          "approved": 1,
          "blocked": 0,
          "escalated": 0,
          "decision_data_unavailable": 1
        },
        "coverage": {
          "events": 2,
          "with_policy_decision_id": 1,
          "joined_policy_decision": 1,
          "with_native_outcome": 0
        }
      },
      "events": []
    }
  }
}
```

### Get A Report Snapshot

```http
GET /v1/governance/reports/grpt_example
X-Platform-Service-Auth: <secret-with-governance-read>
```

Query parameters:

| Parameter   | Required | Notes                     |
| ----------- | -------- | ------------------------- |
| `tenant_id` | Yes      | Tenant that owns the row. |

This route returns the frozen snapshot and does not re-query the live audit
store.
