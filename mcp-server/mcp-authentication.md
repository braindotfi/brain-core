# MCP Authentication

External agents authenticate to Brain's MCP server with a **JWT** that anchors back to an on-chain registration in `BrainMCPAgentRegistry`. There are two layers of verification: the JWT itself, and the cryptographic match between the JWT's `scope_hash` claim and the on-chain hash.

### The Auth Chain

```
┌─────────────────────────────────────────────────┐
│  External agent                              │
│  signs JWT with agent's signing key             │
└────────────────┬────────────────────────────────┘
                 │  Authorization: Bearer <jwt>
                 ▼
┌─────────────────────────────────────────────────┐
│  Brain edge                                     │
│  - Validates JWT signature                      │
│  - Resolves principal (tenant + scopes)         │
└────────────────┬────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────┐
│  MCP dispatcher                                 │
│  Three pre-call checks:                         │
│  1. Agent record in `agents` is `active`        │
│  2. JWT `scope_hash` claim matches on-chain     │
│     hash in BrainMCPAgentRegistry               │
│     (verified once, cached 60 s per agent)      │
│  3. JWT `tenant_id` equals agent's tenant       │
└────────────────┬────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────┐
│  Per-tool scope enforcement                     │
│  Method dispatcher checks the called tool's     │
│  scope against the agent's granted scopes       │
└─────────────────────────────────────────────────┘
```

### JWT Structure

The JWT is signed by the agent's signing key (the same key registered in `BrainMCPAgentRegistry`).

```json
{
  "iss": "agent:0xAgentAddress",
  "sub": "tenant:acme",
  "iat": 1735689600,
  "exp": 1735693200,
  "agent_id": "ag_8231",
  "tenant_id": "acme",
  "scope_hash": "0xabc123..."
}
```

| Claim        | Purpose                                                             |
| ------------ | ------------------------------------------------------------------- |
| `iss`        | Agent's on-chain address                                            |
| `sub`        | Tenant the call is on behalf of                                     |
| `iat`, `exp` | Issued / expiry, max 1-hour TTL                                     |
| `agent_id`   | Brain-internal agent id                                             |
| `tenant_id`  | Tenant id, must match the agent's tenant in `BrainMCPAgentRegistry` |
| `scope_hash` | Hash of the canonical scope document; must match on-chain           |

### On-Chain Scope Verification

This is the move that makes Brain's agent surface different from a typical OAuth integration: **scope is anchored on-chain**.

When the tenant authorized the agent, they signed an EIP-712 message that registered the agent with a `scopeHash` in `BrainMCPAgentRegistry`. The scope document itself stays off-chain; only its hash is on-chain.

```solidity
struct AgentRegistration {
  bytes32 agentId;
  address agentAddress;
  bytes32 tenantId;
  bytes32 scopeHash;     // hash of canonical scope document
  uint256 registeredAt;
  uint256 revokedAt;     // 0 if active
}
```

When an agent makes an MCP call, the JWT presents a `scope_hash` claim. The MCP server verifies that this claim equals the `scopeHash` stored on-chain at the agent's registration record:

| Step | Check                                                    |
| ---- | -------------------------------------------------------- |
| 1    | Read `BrainMCPAgentRegistry.getAgent(agentId)`           |
| 2    | Compare on-chain `scopeHash` to JWT's `scope_hash` claim |
| 3    | Verify `revokedAt == 0` (agent not revoked)              |
| 4    | Verify on-chain `tenantId` matches JWT's `tenant_id`     |

The on-chain read is **cached for 60 seconds per agent**. This balances on-chain verification cost against revocation latency: a revoked agent is rejected within at most 60 seconds.

{% hint style="warning" %}
**Revocation is immediate and on-chain.** A tenant can revoke an agent's authorization at any time by calling `revokeAgent` on `BrainMCPAgentRegistry` with their EIP-712 signature. Within the cache window (<= 60 seconds), the MCP server rejects all subsequent calls.
{% endhint %}

### The Five Capability Scopes

The canonical scope document enumerates which of these the tenant has granted to the agent.

| Scope                    | Allows                                                       |
| ------------------------ | ------------------------------------------------------------ |
| `ledger:read`            | All `ledger.*` read tools and `brain://ledger/...` resources |
| `wiki:read`              | All `wiki.*` read tools and `brain://wiki/...` resources     |
| `raw:write`              | The `raw.contribute` tool                                    |
| `payment_intent:propose` | The `payment_intent.propose` tool                            |
| `execution:propose`      | The `agent.action.propose` tool                              |

A tenant can grant any subset. Unused scopes do not appear in the canonical document. The `scopeHash` is the SHA-256 of the canonical, lexicographically-sorted scope document.

### Per-Call Scope Enforcement

Even after the three pre-call checks pass, each tool invocation is scope-checked. Calling `wiki.question` with a JWT that lacks `wiki:read` returns:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32004,
    "message": "Scope insufficient",
    "data": {
      "required_scope": "wiki:read",
      "granted_scopes": ["ledger:read"]
    }
  }
}
```

### JSON-RPC Error Codes

| Code     | Meaning                                      |
| -------- | -------------------------------------------- |
| `-32001` | JWT invalid or expired                       |
| `-32002` | Agent record not active                      |
| `-32003` | `scope_hash` does not match on-chain hash    |
| `-32004` | Per-call scope insufficient                  |
| `-32005` | Tenant mismatch (JWT tenant != agent tenant) |
| `-32600` | Standard JSON-RPC: invalid request           |
| `-32601` | Standard JSON-RPC: method not found          |
| `-32602` | Standard JSON-RPC: invalid params            |
| `-32603` | Standard JSON-RPC: internal error            |

### Token Lifetimes

| Token                         | TTL           | Refreshable                 |
| ----------------------------- | ------------- | --------------------------- |
| **Agent JWT**                 | Max 1 hour    | Yes; agent signs a new JWT  |
| **Cached scope verification** | 60 seconds    | Auto-refreshes on next call |
| **On-chain registration**     | Until revoked | N/A; on-chain               |

### Revoking an Agent

Two paths:

| Path                  | Effect                                                                            |
| --------------------- | --------------------------------------------------------------------------------- |
| **Tenant in Console** | Generates EIP-712 revocation signature, calls `BrainMCPAgentRegistry.revokeAgent` |
| **Tenant via API**    | `POST /v1/agents/{agent_id}/revoke` with the tenant's signature                   |

After revocation, all calls fail with error `-32002` within the 60-second cache window.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛠️ Tools</strong></td><td>The 10 tools and their per-tool scope requirements.</td><td><a href="tools.md">tools.md</a></td><td></td></tr><tr><td><strong>🪪 BrainMCPAgentRegistry</strong></td><td>The on-chain contract this all anchors to.</td><td><a href="../smart-contracts/brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>
