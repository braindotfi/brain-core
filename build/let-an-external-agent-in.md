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
3. Agent connects to mcp.brain.fi with a JWT.
4. Brain enforces scope on every call.
5. Every read and propose lands in the tenant's audit log.
```

### Step 1: Register the Agent

Agent owners register once. Tenants do not see this step.

```typescript
const agent = await brain.agents.register({
  address:        "0xAgentAddress",
  identityRoot:   "0x...",         // ERC-8004 identity root
  mcpEndpoint:    "https://my-agent.example.com/mcp",
  capabilities:   ["read", "propose_payment", "propose_action"],
});

console.log(agent.id);       // ag_8231
console.log(agent.txHash);   // BrainMCPAgentRegistry registration on Base
```

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
| `payment_intent:propose` | Propose payments for policy evaluation                                   |
| `agent:propose`          | Propose non-financial actions (reconciliation matches, anomaly flags)    |

{% hint style="info" %}
The MCP tool surface is propose-only — there is no execute tool. External agents still execute, but through the smart-account UserOp path, where every action is gated by four independent checks: on-chain agent registration, a tenant-signed EIP-712 ScopeAttestation, a Brain-signed policy verdict bound to the specific UserOperation, and account-level limits. Nothing runs outside an envelope the tenant has signed, and Brain never holds funds.
{% endhint %}

### Step 3: the Agent Connects

The agent owner points their MCP runtime at:

```
mcp.brain.fi   (production)
mcp.brain.dev  (sandbox)
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
| **Execution outside a signed envelope**    | Every execution is gated by four on-chain checks; nothing runs without a tenant-signed scope and a fresh, bound policy verdict |
| **Agents that read across tenants**        | Scope is per-tenant; cross-tenant requires explicit, separate grants |
| **Agents that bypass policy**              | All proposals run through the same Policy evaluator                  |
| **Agents that read each other's evidence** | Tenant isolation extends to evidence contributed by agents           |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔌 MCP server</strong></td><td>The full reference for the MCP surface.</td><td><a href="../mcp-server/overview.md">overview.md</a></td><td></td></tr><tr><td><strong>📜 Audit trail</strong></td><td>Watch what external agents do.</td><td><a href="audit-every-action.md">audit-every-action.md</a></td><td></td></tr></tbody></table>
