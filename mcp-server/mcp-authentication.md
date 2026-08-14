# MCP Authentication

External agents authenticate to Brain's MCP server with a **JWT issued by `auth.brain.fi`**, verified against that service's published JWKS. Authorization then layers on top: the agent's on-chain registration in `BrainMCPAgentRegistry` supplies a `scopeHash` attestation that the server cross-checks against the `agents.scope_hash` DB column before any tool call is allowed.

### The Auth Chain

```
┌─────────────────────────────────────────────────┐
│  External agent                                 │
│  holds a JWT issued by auth.brain.fi             │
└────────────────┬────────────────────────────────┘
                 │  Authorization: Bearer <jwt>
                 ▼
┌─────────────────────────────────────────────────┐
│  Brain edge                                     │
│  - Verifies JWT signature via auth.brain.fi JWKS │
│  - Resolves principal (tenant + scopes)         │
└────────────────┬────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────┐
│  MCP dispatcher                                 │
│  Checks run for principal_type=agent:           │
│  1. Agent record in `agents` is `active`        │
│  2. Agent's DB `scope_hash` matches on-chain    │
│     `scopeHash` in BrainMCPAgentRegistry         │
│     (verified once, cached 60 s per agent)      │
│  3. JWT `tenant_id` equals the DB agent row's   │
│     `tenant_id`                                 │
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

The JWT is issued and signed by `auth.brain.fi`, Brain's own OAuth 2.0 authorization server, and verified by every service (including MCP) against `auth.brain.fi`'s JWKS -- not by any per-agent signing key.

```json
{
  "iss": "https://auth.brain.fi",
  "sub": "agent_01HW3X9QK2Z8N6R4T7Y5V0B1C3",
  "aud": "brain-api",
  "iat": 1735689600,
  "exp": 1735693200,
  "jti": "token_01HW3XA1B2C3D4E5F6G7H8J9K0",
  "tenant_id": "tnt_01HW3XA1B2C3D4E5F6G7H8J9K1",
  "principal_type": "agent",
  "scopes": ["ledger:read", "payment_intent:propose"]
}
```

| Claim            | Purpose                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `iss`            | Always `https://auth.brain.fi`                                                                                |
| `sub`            | The Brain-internal principal id, `agent_<ulid>` for an agent JWT                                              |
| `aud`            | Always `brain-api`                                                                                            |
| `iat`, `exp`     | Issued / expiry, max 1-hour TTL                                                                               |
| `jti`            | Token id, checked against the revocation store                                                                |
| `tenant_id`      | Tenant the call is on behalf of; compared against the `agents` DB row's tenant, not the on-chain registration |
| `principal_type` | `agent` for an MCP-calling agent; `user` for a human proposal decision                                        |
| `scopes`         | The granted capability scopes                                                                                 |

There is **no `scope_hash` claim on the JWT**. The scope-hash comparison described below is entirely server-side: it compares the `scope_hash` column already stored on the `agents` DB row against the hash registered on-chain. The JWT plays no part in that comparison; it only supplies `tenant_id`, `principal_type`, and `scopes`.

### On-Chain Scope Verification

This is the move that makes Brain's agent surface different from a typical OAuth integration: **scope is anchored on-chain**.

When the tenant authorized the agent, they signed an EIP-712 message that registered the agent with a `scopeHash` in `BrainMCPAgentRegistry`. The scope document itself stays off-chain; only its hash is on-chain.

```solidity
struct AgentRegistration {
  bytes32 agentId;
  address agentAddress;
  bytes32 tenantId;
  bytes32 scopeHash;     // keccak-256 of canonical scope set
  bytes32 behaviorHash;  // optional behaviour pin; bytes32(0) if unused
  uint256 registeredAt;
  uint256 revokedAt;     // 0 if active
}
```

The MCP auth verifier (`services/mcp/src/auth.ts`) runs these checks, in order, for every agent-principal request:

| Step | Check                                                                                      |
| ---- | ------------------------------------------------------------------------------------------ |
| 1    | Load the `agents` row for the JWT's `sub`; reject if missing or not `active`               |
| 2    | Reject if the JWT's `tenant_id` does not equal that row's `tenant_id`                      |
| 3    | Read `BrainMCPAgentRegistry.getAgent(agentId)`; reject if unregistered or `revokedAt != 0` |
| 4    | Compare the DB row's `scope_hash` to the on-chain `scopeHash`; reject on mismatch          |

{% hint style="warning" %}
The on-chain registration's own `tenantId` field is decoded by the scope-hash reader but is **never compared to anything**. Step 2 above checks the JWT's `tenant_id` against the `agents` table row, which is a Brain-internal, off-chain comparison -- not a check against the on-chain `tenantId`.
{% endhint %}

The on-chain read is **cached for 60 seconds per agent**. This balances on-chain verification cost against revocation latency: a revoked agent is rejected within at most 60 seconds.

{% hint style="warning" %}
**Revocation is immediate and on-chain.** A tenant can revoke an agent's authorization at any time by calling `revokeAgent` on `BrainMCPAgentRegistry` with their EIP-712 signature. Within the cache window (<= 60 seconds), the MCP server rejects all subsequent calls.
{% endhint %}

### The Capability Scopes

The canonical scope document enumerates which of these the tenant has granted to the agent.

| Scope                    | Allows                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `ledger:read`            | All `ledger.*` read tools, `payment_intent.list`, and `brain://ledger/...` resources                             |
| `wiki:read`              | All `wiki.*` read tools and `brain://wiki/pages/...` resources                                                   |
| `raw:write`              | The `raw.contribute` tool                                                                                        |
| `raw:read`               | The `raw.artifact.get` tool                                                                                      |
| `payment_intent:propose` | The `payment_intent.propose` and `payment_intent.cancel` tools, and the `brain://payments/action_types` resource |
| `payment_intent:approve` | Accepted at the `proposals.decide` call boundary; member approval authority is enforced downstream               |
| `execution:read`         | The `proposals.list`, `proposals.get`, and `evidence.resolve` tools; also accepted by `proposals.decide`         |
| `execution:propose`      | The `agent.action.propose` tool                                                                                  |
| `audit:read`             | The `brain://proofs/{action_id}` resource                                                                        |

A tenant can grant any subset. Unused scopes do not appear in the canonical document. The `scopeHash` is the **keccak-256** of the canonical, lexicographically-sorted scope set (`computeAgentScopeHash` in `shared/src/agents/capability.ts`); it is the same hash the registration tooling writes on-chain, so the seed, the DB row, and the registry agree byte-for-byte.

### Per-Call Scope Enforcement

Even after the pre-dispatch checks pass, each tool invocation is scope-checked. Calling `wiki.question` with a JWT that lacks `wiki:read` returns:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32002,
    "message": "tool 'wiki.question' requires scope 'wiki:read'",
    "data": {
      "brain_code": "auth_scope_insufficient",
      "details": { "required": ["wiki:read"], "held": ["ledger:read"] }
    }
  }
}
```

Per-call scope enforcement runs **after** authentication, inside JSON-RPC dispatch, so it surfaces as a JSON-RPC `error` (HTTP `200`), unlike the pre-dispatch auth checks below.

### Error Codes: two surfaces

Brain's MCP surface fails in two distinct places, and the shape of the error differs:

**1. Pre-dispatch auth failures -- HTTP `401`/`403` Brain error envelope.** The route guard (`services/mcp/src/transport/http.ts`) checks the JWT and principal type; the auth verifier (`services/mcp/src/auth.ts`, run at the top of `server.handle`) checks on-chain registration, scope-hash, and tenant. All of these throw a `BrainError` that propagates out of the handler **before** any method is dispatched, so the client sees an HTTP `401`/`403` with a Brain error envelope, **not** a JSON-RPC response. The envelope shape is `{ "error": { "code": ..., "message": ..., "details": ..., "request_id": ..., "docs_url": ... } }` (Brain Engineering Standards §4.1), not the flatter `{ "error_code": ..., "message": ... }` shape.

| `error_code`                         | HTTP | Meaning                                               |
| ------------------------------------ | ---- | ----------------------------------------------------- |
| `auth_token_missing/invalid/expired` | 401  | JWT absent, malformed, or expired                     |
| `auth_scope_insufficient`            | 401  | Principal is not `principal_type=agent` (or `user`)   |
| `auth_tenant_mismatch`               | 401  | JWT `tenant_id` != agent's registered tenant          |
| `agent_not_registered`               | 401  | Agent row missing in `agents`, or not `active`        |
| `agent_not_registered_onchain`       | 401  | Agent has no record in `BrainMCPAgentRegistry`        |
| `agent_scope_hash_missing`           | 401  | Agent row has no on-chain scope attestation           |
| `agent_scope_hash_mismatch`          | 401  | DB `scope_hash` differs from the on-chain `scopeHash` |

**2. Post-auth JSON-RPC errors -- HTTP `200` with a JSON-RPC `error`.** Once the call has authenticated, failures inside method dispatch (scope, gate, params, not-found) are carried in the JSON-RPC `error` field with `data.brain_code` set:

| Code     | Meaning                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-32001` | JWT invalid/expired (`auth_token_*`), in-dispatch only                                                                                                                      |
| `-32002` | Scope insufficient / tenant mismatch (`auth_scope_insufficient`, `auth_tenant_mismatch`)                                                                                    |
| `-32003` | Agent not registered or inactive (`agent_not_registered`, `agent_not_registered_onchain`)                                                                                   |
| `-32004` | Pre-execution gate failed (`payment_intent_gate_failed`, every `gate_*`)                                                                                                    |
| `-32005` | On-chain `scope_hash` mismatch (`agent_scope_hash_mismatch`)                                                                                                                |
| `-32600` | Standard JSON-RPC: invalid request                                                                                                                                          |
| `-32601` | Standard JSON-RPC: method not found                                                                                                                                         |
| `-32602` | Standard JSON-RPC: invalid params, including a valid-looking id that resolves to nothing (`*_not_found`, `payment_intent_invalid_state`, `payment_intent_approval_invalid`) |
| `-32603` | Standard JSON-RPC: internal error                                                                                                                                           |

The numeric mapping lives in `services/mcp/src/dispatcher.ts`. In practice the auth-class codes (`-32001`/`-32002`/`-32003`/`-32005`) are reached via the HTTP envelope above, since auth runs before dispatch; the JSON-RPC codes you will actually observe in a `200` body are `-32004` (gate), `-32002` (per-tool scope), `-32602` (bad params or not-found), and the standard `-326xx` family.

### Token Lifetimes

| Token                         | TTL           | Refreshable                           |
| ----------------------------- | ------------- | ------------------------------------- |
| **Agent JWT**                 | Max 1 hour    | Yes; `auth.brain.fi` issues a new one |
| **Cached scope verification** | 60 seconds    | Auto-refreshes on next call           |
| **On-chain registration**     | Until revoked | N/A; on-chain                         |

### Revoking an Agent

Two paths:

| Path                  | Effect                                                                            |
| --------------------- | --------------------------------------------------------------------------------- |
| **Tenant in Console** | Generates EIP-712 revocation signature, calls `BrainMCPAgentRegistry.revokeAgent` |
| **Tenant via API**    | `POST /v1/agents/{agent_id}/revoke` with the tenant's signature                   |

After revocation, the on-chain `revokedAt` becomes non-zero, so the scope read returns null and, within the 60-second cache window, all calls are rejected pre-dispatch with an HTTP `401` `agent_not_registered_onchain` envelope.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛠️ Tools</strong></td><td>The 17 tools and their per-tool scope requirements.</td><td><a href="tools.md">tools.md</a></td><td></td></tr><tr><td><strong>🪪 BrainMCPAgentRegistry</strong></td><td>The on-chain contract this all anchors to.</td><td><a href="../smart-contracts/brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>
