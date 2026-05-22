---
description: Who can read, propose, and act. First-party and external.
---

# Agents

In Brain, an **agent** is any non-human caller that proposes or executes actions on a tenant's behalf. Agents and humans share the same authorization model. The only thing that differs is the credential.

| Caller                                | Credential                                |
| ------------------------------------- | ----------------------------------------- |
| **Human**                             | OAuth/SSO via the Console                 |
| **First-party agent** (your backend)  | Server API key                            |
| **External agent** (third-party software) | JWT, anchored to an on-chain registration |

All three hit the same endpoints, run through Policy, and land in the Audit log.

### First-party vs External

You can use Brain in two ways: **build agents on top of it** or **let other people's agents in**.

| Pattern         | What it looks like                                                                          |
| --------------- | ------------------------------------------------------------------------------------------- |
| **First-party** | Your backend uses the SDK. Your code is the first-party agent.                              |
| **External**    | Someone else's MCP-compatible agent connects to Brain. The tenant authorizes it explicitly. |

Most apps start with first-party agents. External agents become useful when:

* Your tenant wants to use a specialist agent (a vendor-management bot, a treasury agent) you didn't build
* You're building a marketplace where tenants pick agents
* You're integrating a third-party assistant that should see a tenant's financial state

### How Agents Act

Whether first-party or external, the lifecycle is the same:

```
1. Read context (memory, citations)
2. Propose an action
3. Brain runs Policy
4. If allowed, the action executes (or routes to a human)
5. Audit anchors what happened
```

An agent proposes; Brain decides. Agents do not bypass Policy.

### What External Agents Can Do

Tenant-granted scopes determine what an external agent sees and can do.

| Scope                    | Allows                                                                   |
| ------------------------ | ------------------------------------------------------------------------ |
| `ledger:read`            | Read transactions, balances, counterparties, obligations                 |
| `wiki:read`              | Ask natural-language questions; get cited answers                        |
| `raw:write`              | Push artifacts (transcripts, contracts) into the tenant's evidence layer |
| `payment_intent:propose` | Propose payments for policy evaluation                                   |
| `agent:propose`          | Propose non-financial actions                                            |

A tenant can grant any subset. Unused scopes don't appear in the agent's available tools.

{% hint style="info" %}
External agents both propose and execute actions, but only inside an envelope the tenant has explicitly signed. Every execution is gated by four independent checks: on-chain agent registration, a tenant-signed EIP-712 ScopeAttestation, a Brain-signed policy verdict bound to the specific UserOperation, and account-level transaction limits. If any check fails, the action reverts on-chain. Brain never holds funds; the tenant's smart account or EOA pays, the agent's address receives.
{% endhint %}

### How External Agents Stay Accountable

Four properties combine to make external agents safe to authorize:

| Property            | Mechanism                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity**        | Agent registered in `BrainMCPAgentRegistry` on Base; ERC-8004 record keyed by execution address                                                    |
| **Scope**           | Tenant signs an EIP-712 `ScopeAttestation` granting a specific capability, max amount, resource scope, and validity window. Checked on every UserOp by `BrainSmartAccount._verifyScope`. |
| **Policy verdict**  | Brain's `policyVerifier` key signs an `ALLOW` verdict bound to the exact `userOpHash`, with a 60-second TTL. Not replayable.                       |
| **Account limits**  | Global `perTx` and rolling `perDay` ceilings in the smart account cap blast radius even when policy and scope are valid.                           |

Policy is enforced twice on purpose: off-chain at proposal time for fast feedback, and on-chain at UserOp validation as the hard backstop. Even a compromised Brain backend cannot execute against the smart account without a fresh, scope-bound, agent-bound verdict.

### How First-party Agents Stay Accountable

Same audit log, same Policy gating. Your server keys are scoped (you can issue narrow keys per service), and every call carries the key fingerprint. Compromised keys can be revoked, and the trail of what they did before revocation is recoverable.

### What "MCP-Compatible" Means

[MCP](https://modelcontextprotocol.io) is the open standard for connecting agents to tools and data sources. Brain runs an MCP server at `mcp.brain.fi`. Any agent built on an MCP-compatible runtime can connect.

You don't have to know any of this if you're only building first-party agents. The MCP server matters when you want to **be a destination** for third-party agents.

[**→ MCP server**](../mcp-server/overview.md)

### Related

| Concept                            | Page             |
| ---------------------------------- | ---------------- |
| What agents read                   | Memory           |
| The rules that gate every action   | Policy           |
| The audit record of agent activity | Proof            |
| Deep dive                          | Protocol: Agents |
