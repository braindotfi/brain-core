# Agents API

Register agents, grant scope, list capabilities, and inspect reputation.

### Register an Agent

```http
POST /v1/agents
Authorization: Bearer <tenant token>
Content-Type: application/json

{
  "agent_address": "0xagent...",
  "capabilities":  ["pay_invoice", "rebalance_treasury"],
  "mcp_endpoint":  "https://my-agent.example.com/mcp",
  "metadata_uri":  "ipfs://Qm..."
}
```

Response:

```json
{
  "id": "ag_...",
  "address": "0xagent...",
  "identity_root": "0x...",
  "reputation_root": "0x...",
  "registered_at": "2025-09-01T...",
  "active": true,
  "anchored_tx_hash": "0x..."
}
```

The registration is anchored on `BrainMCPAgentRegistry` on Base.

### Grant Scope to an Agent

The tenant signs an EIP-712 ScopeAttestation and submits it.

```http
POST /v1/agents/{agent_address}/scope
Authorization: Bearer <tenant token>
Content-Type: application/json

{
  "tenantId":      "acme",
  "capability":    "pay_invoice",
  "max_amount":    "10000_000000",
  "resource_scope":"0x...",
  "not_before":    0,
  "not_after":     1735689600,
  "nonce":         0,
  "signature":     "0x..."
}
```

EIP-712 type:

```
ScopeAttestation(
  bytes32 tenantId,
  address agent,
  bytes32 capability,
  uint128 maxAmount,
  bytes32 resourceScope,
  uint64  notBefore,
  uint64  notAfter,
  uint256 nonce
)
```

### List Agents

```http
GET /v1/agents?tenantId=acme&capability=pay_invoice
Authorization: Bearer <tenant token>
```

Response:

```json
{
  "items": [
    {
      "id": "ag_...",
      "address": "0xagent...",
      "capabilities": ["pay_invoice"],
      "reputation_score": 94,
      "active": true,
      "scope_grants": [
        { "capability": "pay_invoice", "max_amount": "10000_000000", "expires_at": "..." }
      ]
    }
  ]
}
```

### Get an Agent

```http
GET /v1/agents/{agent_id_or_address}
Authorization: Bearer <token>
```

### Pause / Resume / Revoke

```http
POST   /v1/agents/{agent_id}/pause
POST   /v1/agents/{agent_id}/resume
DELETE /v1/agents/{agent_id}
```

| State       | What It Means                                         | Reversible |
| ----------- | ----------------------------------------------------- | ---------- |
| **Active**  | Agent can propose actions                             | n/a        |
| **Paused**  | Proposals rejected; identity and reputation preserved | ✅ Yes     |
| **Revoked** | Permanent termination; record preserved for audit     | ❌ No      |

### Reputation

```http
GET /v1/agents/{agent_address}/reputation
Authorization: Bearer <token>
```

Response:

```json
{
  "score": 94,
  "successful_actions": 412,
  "failed_actions": 3,
  "completed_payments": 209,
  "reputation_root": "0x...",
  "merkle_proof": ["0x...", "..."],
  "last_updated": "2025-09-01T..."
}
```

{% hint style="info" %}
Reputation is stored off-chain and committed as a Merkle root per agent. The `reputation_root` is registered in `BrainMCPAgentRegistry`. Verifiers receive the root and a Merkle proof for the specific attestation they care about.
{% endhint %}

### Submit a Performance Attestation

After an action completes, the tenant can sign a performance attestation that contributes to the agent's reputation.

```http
POST /v1/agents/{agent_address}/attest
Authorization: Bearer <tenant token>
Content-Type: application/json

{
  "actionId":   "act_...",
  "outcome":    "success",
  "rating":     5,
  "comment":    "Reconciled correctly under tight deadline.",
  "signature":  "0x..."
}
```

### Propose an Action

This is where most agent activity happens. See the Actions API for the full proposal/approval/execution flow.

```http
POST /v1/agents/{agent_id}/propose
Authorization: Bearer <agent or tenant token>
Content-Type: application/json

{
  "tenantId": "acme",
  "action":   { "type": "pay_invoice", "invoiceId": "inv_8231" }
}
```

### Route to an Agent

Ask Brain which agent should handle an event or a natural-language intent. The router filters candidates by capability and by the tenant's scope grants, scores them, and returns the best agent plus fallbacks. Routing only selects; the selected agent still proposes through `POST /v1/agents/{id}/propose`, which runs Policy and the pre-execution gate. The selection is itself an audit event.

```http
POST /v1/agents/route
Authorization: Bearer <tenant token>
Content-Type: application/json

{
  "tenant_id": "acme",
  "event":     "invoice.overdue",
  "context":   { "invoice_id": "inv_8231", "counterparty_id": "cp_x" }
}
```

Supply `event` (a domain-event name) or `intent` (free-form text), and optional `context`. Requires the `execution:read` scope; `tenant_id` must match the authenticated tenant.

Response:

```json
{
  "selected_agent_id":  "collections",
  "fallback_agent_ids": [],
  "confidence":         0.92,
  "evidence_score":     1,
  "policy_status":      "routed",
  "execution_mode":     "propose",
  "reason":             "selected collections (confidence 0.92)"
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

## Agent Autonomy v3

The full route → resolve → propose pipeline and the kill-switch. **Money-movers are shadowed by default** — a financial proposal from an un-promoted agent terminates as `shadow_completed` and moves no money (going live is a deliberate per-agent promotion with strict caps + allowlisted rails).

### Run an agent

```http
POST /v1/agents/run
Authorization: Bearer <tenant token>

{ "event": "invoice.overdue", "context": { "invoice_id": "inv_1" } }
```

Routes the event/intent, resolves the action within the selected agent, evaluates the §6 gate in dry-run, persists an `agent_runs` row, and proposes through the gated path. Returns `{ status, run_id, routing_decision_id, selected_agent_id, action, shadow_mode, proposed?, reason }`. A proposal-layer idempotency collision returns `409 AGENT_PROPOSAL_DUPLICATE`.

### Routing, events, and run history

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/agents/route` | Routing decision only (no run) |
| `POST /v1/agents/events` | Enqueue an event-driven route/run job |
| `GET /v1/agents/runs` | List runs (filter `agent_id`, `status`, `category`, `limit`) |
| `GET /v1/agents/runs/{run_id}` | Run detail |
| `GET /v1/agents/runs/{run_id}/why` | Structured reason + (redacted) reasoning trace + gate trace + rail receipt |
| `GET /v1/agents/routing-decisions/{id}` | Routing decision detail |

### Kill-switch

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/agents/{agent_id}/halt` | Pause all the agent's in-flight intents and set its state to `quarantined` |
| `POST /v1/agents/halt-category` | Emergency-stop every agent in a category (`business` / `consumer` / `agnostic`) |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📤 Actions API</strong></td><td>Propose, approve, execute.</td><td><a href="actions-api.md">actions-api.md</a></td><td></td></tr><tr><td><strong>📜 BrainMCPAgentRegistry</strong></td><td>The on-chain registry.</td><td><a href="../smart-contracts/brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>
