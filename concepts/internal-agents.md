---
description: Brain-shipped agents are first-class participants, not a parallel system.
---

# Internal Agents

Brain ships a small set of its own agents (for example, collections, treasury, and reconciliation). These **internal agents** are not a separate mechanism. They register in the same registry, pass the same validation, and propose through the same path as any third-party agent. The only thing that distinguishes them is a metadata field and who operates the execution key.

## Three Kinds of Caller

| Kind            | Who builds it              | Provenance | Credential                         |
| --------------- | -------------------------- | ---------- | ---------------------------------- |
| **Internal**    | Brain ships it             | `internal` | Brain-operated execution key       |
| **First-party** | The customer's own backend | n/a        | Server API key                     |
| **External**    | A third party              | `external` | JWT anchored to an on-chain record |

"Internal" and "external" are values of the agent's `provenance` metadata (stored as the agent record's `kind`). "First-party" describes a customer backend calling Brain with its own API key; it is a usage pattern, not a registry entry.

## Same Registry, Same Validation

An internal agent is registered in `BrainMCPAgentRegistry` exactly like an external one: an `agentId`, an execution address, a per-tenant `scopeHash`, and a tenant-signed authorization. When an internal agent settles on-chain, its UserOperation passes the same four `BrainSmartAccount` checks as any agent:

1. the agent is registered for the tenant,
2. a valid, non-expired tenant-signed `ScopeAttestation` is present,
3. a Brain-signed policy verdict is bound to the exact `userOpHash`, and
4. the action is within account-level limits.

There is no `BrainNativeAgent` and no bypass. Capabilities are identified by `keccak256(name)` and fold into the agent's `scopeHash`, the same as for external agents.

## The Shared Pattern

Every internal agent is described by an **agent definition**: its capabilities, the events and intent patterns it responds to, the data it may read, its risk level, its minimum confidence, the evidence it requires, and its default authority. A handler turns a triggered action into a proposal. The agent never executes; it proposes through `POST /v1/agents/{id}/propose`, which runs Policy and the deterministic pre-execution gate.

## Routing

A multi-agent router selects an agent for an incoming event or intent. It filters candidates by capability and by the tenant's scope grants, scores them by trigger match, intent match, evidence completeness, reputation, and cost, and returns the best agent plus fallbacks. The selection is itself an audit event, so a tenant can later verify why a particular agent was chosen. Routing only selects; the selected agent still proposes through the gated path.

## The Decision

The proposal decision stays `ALLOW`, `ESCALATE`, or `DENY`. Internal agents add three fields to that response without changing it: `confidence`, `evidence_score`, and an `execution_mode` of `execute`, `propose`, `confirm`, `notify_only`, or `reject`. Low confidence or missing required evidence yields `notify_only`: surface to a human, take no action. Existing callers that read `decision` are unaffected.

## Related

| Topic                          | Page                                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| The shared authorization model | [Agents](agents.md)                                                  |
| How agent actions are gated    | [Policy](policy.md)                                                  |
| The agent layer in depth       | [Protocol: Agents](../protocol/agents.md)                            |
| The on-chain identity contract | [BrainMCPAgentRegistry](../smart-contracts/brainmcpagentregistry.md) |
