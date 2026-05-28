# Agents API

Register external agents, list the first-party agent catalog, route events to agents, run agents end-to-end, inspect runs, and halt agents.

| Operation                                         | Endpoint                                             |
| ------------------------------------------------- | ---------------------------------------------------- |
| Register an external agent                        | `POST /v1/execution/agents/register`                 |
| List first-party agent catalog                    | `GET  /v1/agents`                                    |
| Get an agent (definition + on-chain registration) | `GET  /v1/agents/{agent_id}`                         |
| List an agent's actions                           | `GET  /v1/agents/{agent_id}/actions`                 |
| Route an event/intent                             | `POST /v1/agents/route`                              |
| Run an agent end-to-end                           | `POST /v1/agents/run`                                |
| Enqueue an event for async routing                | `POST /v1/agents/events`                             |
| Inspect a routing decision                        | `GET  /v1/agents/routing-decisions/{id}`             |
| List runs                                         | `GET  /v1/agents/runs`                               |
| Run detail                                        | `GET  /v1/agents/runs/{run_id}`                      |
| Why a run did what it did                         | `GET  /v1/agents/runs/{run_id}/why`                  |
| Evidence used for a run                           | `GET  /v1/agents/runs/{run_id}/evidence`             |
| §6 gate trace for a run                           | `GET  /v1/agents/runs/{run_id}/gate-trace`           |
| Canonical Proof for a run                         | `GET  /v1/agents/runs/{run_id}/proof`                |
| Halt one agent                                    | `POST /v1/agents/{agent_id}/halt`                    |
| Halt every agent in a category                    | `POST /v1/agents/halt-category`                      |
| MCP JSON-RPC entry                                | `POST /v1/agents/mcp` (see MCP Server API Reference) |

{% hint style="warning" %}
`POST /v1/agents/register` and `POST /v1/agents/{agent_id}/propose` are marked **deprecated** in the spec and **return 404** today. Register external agents via `POST /v1/execution/agents/register` (below), and propose actions through `POST /v1/agents/run` (which routes → resolves → dry-runs the §6 gate → proposes through the gated path).
{% endhint %}

### Register an External Agent

External agents are registered with a tenant-signed `AgentScope` attestation; Brain stores the record and writes the on-chain registration to `BrainMCPAgentRegistry`.

```http
POST /v1/execution/agents/register
Authorization: Bearer <tenant token>
Content-Type: application/json

{
  "agent_address": "0xagent...",
  "scope": {
    "allowed_actions":          ["read_wiki", "propose_action", "read_audit"],
    "wiki_kinds_readable":      ["counterparty", "obligation"],
    "action_types_proposable":  ["outbound_payment"],
    "max_amount":               { "currency": "USD", "value": "10000" },
    "valid_until":              "2026-12-31T23:59:59Z"
  },
  "tenant_signature": "0x..."
}
```

Response (`201 Created`):

```json
{
  "agent_id": "ag_...",
  "onchain_tx_hash": "0x...",
  "scope_hash": "abc123..."
}
```

The agent then connects over MCP using a JWT whose `scope_hash` claim must equal the `scope_hash` stored on-chain — the MCP server verifies that match on every call.

### List the First-Party Agent Catalog

`GET /v1/agents` returns the **internal** first-party agent definitions (capability, category, default-enabled state) — not the external-agent registry.

```http
GET /v1/agents?category=business&state=enabled
Authorization: Bearer <token>
```

```json
{
  "agents": [
    {
      "agent_key": "collections",
      "provenance": "first_party",
      "category": "business",
      "capabilities": ["invoice_followup", "dunning"],
      "enabled_by_default": true
    }
  ]
}
```

Filters: `kind`, `capability`, `category` (`business | consumer | agnostic`), `state` (`enabled | disabled`).

### Get an Agent

```http
GET /v1/agents/{agent_id}
Authorization: Bearer <token>
```

Returns the catalog definition plus, if present, the on-chain registration record (`agentId`, `agentAddress`, `tenantId`, `scopeHash`, `behaviorHash`, `registeredAt`).

### Route an Event

The router scores candidate agents by capability + tenant scope grants + evidence and returns the best one. Routing is advisory — the selected agent still proposes through the gated path. The selection is itself an audit event.

```http
POST /v1/agents/route
Authorization: Bearer <token>
Content-Type: application/json

{
  "event":   "invoice.overdue",
  "context": { "invoice_id": "inv_8231", "counterparty_id": "cp_x" }
}
```

Provide `event` (a domain-event name) **or** `intent` (free-form text), plus optional `context`. Tenant-equality required.

```json
{
  "selected_agent_id": "collections",
  "fallback_agent_ids": [],
  "confidence": 0.92,
  "evidence_score": 1,
  "policy_status": "routed",
  "execution_mode": "propose",
  "reason": "selected collections (confidence 0.92)"
}
```

| Field                | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `selected_agent_id`  | The chosen agent, or `null` when nothing matches                     |
| `fallback_agent_ids` | Other eligible agents, best first                                    |
| `confidence`         | Router confidence in the selection (0..1)                            |
| `evidence_score`     | Fraction of the agent's required evidence that is present (0..1)     |
| `policy_status`      | `routed`, `unscoped` (matched but tenant scoped none), or `no_match` |
| `execution_mode`     | `execute`, `propose`, `confirm`, `notify_only`, `reject`, or `null`  |

### Run an Agent End-to-End

The full route → resolve action → dry-run §6 gate → persist `agent_runs` row → propose pipeline. **Money-movers are shadowed by default** — a financial proposal from an un-promoted agent terminates as `shadow_completed` and moves no money. Going live is a deliberate per-agent promotion with strict caps + allowlisted rails.

```http
POST /v1/agents/run
Authorization: Bearer <token>
Content-Type: application/json

{ "event": "invoice.overdue", "context": { "invoice_id": "inv_8231" } }
```

```json
{
  "status":              "proposal_created",
  "routing_decision_id": "rd_001",
  "run_id":              "run_001",
  "selected_agent_id":   "collections",
  "action":              { "type": "outbound_payment", ... },
  "shadow_mode":         false,
  "proposed":            { "id": "pi_a1b2c3", "status": "pending_approval", "policy_decision_id": "pd_7331" },
  "reason":              "matched dunning rule for inv_8231"
}
```

A proposal-layer idempotency collision returns `409` with `agent_proposal_duplicate`.

### Enqueue an Event (async)

```http
POST /v1/agents/events
Authorization: Bearer <token>
Content-Type: application/json

{ "event": "invoice.overdue", "context": { "invoice_id": "inv_8231" } }
```

```json
{ "job_id": "job_001", "status": "queued" }
```

### Routing Decisions & Run History

| Endpoint                                  | Purpose                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /v1/agents/routing-decisions/{id}`   | Routing decision detail                                                             |
| `GET /v1/agents/runs`                     | List runs (filter `agent_id`, `status`, `category`, `limit`)                        |
| `GET /v1/agents/runs/{run_id}`            | Run summary (`status` ∈ `completed`, `failed`, `shadow_completed`, `rejected`)      |
| `GET /v1/agents/runs/{run_id}/why`        | Structured reason + (redacted) reasoning trace + candidate agents + `behavior_hash` |
| `GET /v1/agents/runs/{run_id}/evidence`   | Evidence the run consulted                                                          |
| `GET /v1/agents/runs/{run_id}/gate-trace` | The §6 gate-check rows for the run's PaymentIntent                                  |
| `GET /v1/agents/runs/{run_id}/proof`      | Proxy to the canonical Proof artifact for the run's PaymentIntent                   |
| `GET /v1/agents/{agent_id}/actions`       | All actions a given agent produced (proposal + payment_intent + status)             |

### Kill-Switch

| Endpoint                          | Purpose                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `POST /v1/agents/{agent_id}/halt` | Pause every in-flight intent for the agent and set its state to `quarantined` |
| `POST /v1/agents/halt-category`   | Emergency-stop every agent in a category — body `{ "category": "business" }`  |

Both routes are tenant-root and emit audit events. Halting an agent atomically pauses its in-flight PaymentIntents (the rail dispatcher re-reads state immediately before submission and aborts cleanly if the intent was paused).

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📤 Payment Intents</strong></td><td>The Ledger entity agents propose.</td><td><a href="payment-intents-api.md">payment-intents-api.md</a></td><td></td></tr><tr><td><strong>📜 BrainMCPAgentRegistry</strong></td><td>The on-chain registry.</td><td><a href="../smart-contracts/brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>
