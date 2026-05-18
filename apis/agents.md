# Agents

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
  "id":              "ag_...",
  "address":         "0xagent...",
  "identity_root":   "0x...",
  "reputation_root": "0x...",
  "registered_at":   "2025-09-01T...",
  "active":          true,
  "anchored_tx_hash":"0x..."
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
      "id":              "ag_...",
      "address":         "0xagent...",
      "capabilities":    ["pay_invoice"],
      "reputation_score":94,
      "active":          true,
      "scope_grants":    [
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
| **Paused**  | Proposals rejected; identity and reputation preserved | ✅ Yes      |
| **Revoked** | Permanent termination; record preserved for audit     | ❌ No       |

### Reputation

```http
GET /v1/agents/{agent_address}/reputation
Authorization: Bearer <token>
```

Response:

```json
{
  "score":               94,
  "successful_actions":  412,
  "failed_actions":      3,
  "completed_payments":  209,
  "reputation_root":     "0x...",
  "merkle_proof":        ["0x...", "..."],
  "last_updated":        "2025-09-01T..."
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
