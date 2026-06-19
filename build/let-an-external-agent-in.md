---
description: Authorize an MCP-compatible agent to read and propose on a tenant's behalf.
---

# Let an External Agent In

Goal: authorize an external agent (one you didn't write) to read a tenant's financial state and propose actions on the tenant's behalf, with the same policy and audit guarantees as anything you'd build yourself.

External agents speak [MCP](https://modelcontextprotocol.io). Brain ships an MCP server. The integration is mostly authorization, not code.

### The Flow

```
1. Agent owner registers their agent with Brain.
2. Tenant grants the agent specific scopes (read, propose, etc.).
3. Agent connects to the MCP endpoint (POST /v1/agents/mcp) with a JWT.
4. Brain enforces scope on every call.
5. Every read and propose lands in the tenant's audit log.
```

### Step 1: Register the Agent

Agent owners register once. Tenants do not see this step.

```typescript
const agent = await brain.agents.register({
  address:        "0xAgentAddress",
  capabilities:   ["read", "propose_payment", "propose_action"],
  // Planned (RFC 0001), NOT yet anchored on-chain; accepted by the SDK but
  // dropped before the on-chain write:
  identityRoot:   "0x...",                          // ERC-8004 identity root (planned, RFC 0001)
  mcpEndpoint:    "https://my-agent.example.com/mcp",
});

console.log(agent.id);       // ag_8231
console.log(agent.txHash);   // BrainMCPAgentRegistry registration on Base
```

{% hint style="warning" %}
**What actually lands on-chain.** The deployed `BrainMCPAgentRegistry` struct stores only `agentId`, `agentAddress`, `tenantId`, `scopeHash`, and `behaviorHash`. `identityRoot`, `mcpEndpoint`, and `capabilities[]` are the **planned** ERC-8004 target (RFC 0001) and are not anchored today. Your `capabilities` are not written as a list; the SDK compiles them (together with the scope grant in Step 2) into the single `scopeHash` the contract stores, and the agent's JWT `scope_hash` claim must equal it. Under the hood this is a tenant-signed registration via `POST /v1/execution/agents/register`. See [BrainMCPAgentRegistry](../smart-contracts/brainmcpagentregistry.md).
{% endhint %}

### Step 2: Grant the Agent Scope

The tenant authorizes the agent for specific capabilities, on this tenant only.

```typescript
const grant = await brain.agents.grantScope("acme", agent.id, {
  scopes: [
    "ledger:read",
    "wiki:read",
    "payment_intent:propose",
  ],
  validFrom: Date.now(),
  validTo:   Date.now() + 30 * 86400_000,  // 30 days
});
```

The tenant signs an EIP-712 message under the hood; the SDK handles it. The grant's hash is anchored on Base.

| Scope                    | Allows                                                                   |
| ------------------------ | ------------------------------------------------------------------------ |
| `ledger:read`            | Read accounts, transactions, obligations, counterparties                 |
| `wiki:read`              | Ask natural-language questions; get cited answers                        |
| `raw:write`              | Push artifacts (transcripts, documents) into the tenant's evidence layer |
| `payment_intent:propose` | Propose payments (cannot execute)                                        |
| `execution:propose`      | Propose non-financial actions (reconciliation matches, anomaly flags)    |

{% hint style="warning" %}
External agents only ever **propose**; they never **execute**. Once an action is approved (Policy returned `allow`, or all required human approvals are in), Brain's internal settlement path runs the §6 gate and dispatches it. The proposing agent never moves the money itself, and a human approval supplies a signature, not a settlement call. That separation is the safety guarantee that makes external agents safe to authorize.
{% endhint %}

#### One permission, three vocabularies

The same grant is spelled three ways depending on the surface. They map 1:1:

| SDK `register` capability | SDK `grantScope` scope    | HTTP `allowed_actions` / `action_types_proposable` |
| ------------------------- | ------------------------- | -------------------------------------------------- |
| `read`                    | `ledger:read`, `wiki:read` | `read_wiki` (+ `read_ledger`, `read_audit`)        |
| `propose_payment`         | `payment_intent:propose`  | `action_types_proposable: ["outbound_payment", …]` |
| `propose_action`          | `execution:propose`       | `propose_action`                                   |
| (contribute evidence)     | `raw:write`               | `write_raw`                                        |

The SDK `register` capabilities are the coarse intent; `grantScope` scopes are the canonical `{layer}:{verb}` strings the gate checks; the [HTTP `POST /v1/execution/agents/register`](../api-reference/agents-api.md#register-an-external-agent) body uses `allowed_actions` + `action_types_proposable`. Pick the vocabulary for your surface; Brain stores them all as one `scopeHash`.

### Step 3: the Agent Connects

The MCP surface is a JSON-RPC endpoint on the same API host. There is no separate MCP hostname. The agent owner points their MCP runtime at:

```
POST https://api.brain.fi/v1/agents/mcp           (production)
POST https://api.sandbox.brain.fi/v1/agents/mcp   (sandbox)
```

The runtime authenticates with a JWT signed by the agent's registered key. The first call discovers the tools the agent has scope for.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list"
}
```

A tenant who granted only `ledger:read` and `wiki:read` will see exactly those tools and no others.

### Step 4: the Agent Works

From the agent's side, calls look like this.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "wiki.question",
    "arguments": {
      "tenant_id": "acme",
      "question":  "What invoices are overdue?"
    }
  }
}
```

The same Policy gating, the same Wiki memory, the same audit emission as anything you'd call from your own backend. Identical guarantees.

### Step 5: You Watch

Every external agent action lands in the tenant's audit log.

```typescript
const events = await brain.audit.list("acme", {
  actor: `agent:${agent.id}`,
  from:  "2025-09-01",
});

events.data.forEach((e) => console.log(e.type, e.timestamp, e.summary));
```

The Console shows agent activity in real time under **Agents → Activity**.

### Revoking an Agent

Revocation is immediate.

```typescript
await brain.agents.revoke("acme", agent.id);
```

Within at most 60 seconds (the on-chain scope cache window), the agent's calls fail. Already-stored evidence and prior actions remain (the audit log is immutable). Future calls are rejected.

### What This Enables

| Pattern                  | Example                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Specialist agents**    | A vendor-management agent authorized to read invoices and counterparties only                          |
| **Compliance bots**      | A bot authorized to read audit events and flag anomalies                                               |
| **Cross-product agents** | An agent that contributes evidence (transcripts, contracts) to multiple tenants under their own scopes |
| **Marketplaces**         | Tenants discover, authorize, and revoke agents from a marketplace without writing code                 |

### What This Does Not Enable

| Pattern                                    | Why not                                                              |
| ------------------------------------------ | -------------------------------------------------------------------- |
| **External agents that execute**           | Execution is internal-only by design                                 |
| **Agents that read across tenants**        | Scope is per-tenant; cross-tenant requires explicit, separate grants |
| **Agents that bypass policy**              | All proposals run through the same Policy evaluator                  |
| **Agents that read each other's evidence** | Tenant isolation extends to evidence contributed by agents           |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔌 MCP Server</strong></td><td>The full reference for the MCP surface.</td><td><a href="../mcp-server/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>📜 Audit Trail</strong></td><td>Watch what external agents do.</td><td><a href="audit-every-action.md">audit-every-action.md</a></td><td></td></tr></tbody></table>
