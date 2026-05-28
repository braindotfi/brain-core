# Agents

The Agent Layer coordinates **internal and external agents**. Brain ships a small set of internal agents (payments, reconciliation, reporting). The layer is also an open registry. External agents authenticate via SIWX, advertise capabilities, and execute through `BrainSmartAccount`.

{% hint style="info" %}
Brain does not need to build every agent. **It is the substrate they share.** External agents listed on Brain do not need to ship their own ledger, memory, policy engine, or audit pipeline.
{% endhint %}

{% hint style="info" %}
**Internal agents are first-class participants of this same layer.** A Brain-shipped agent registers in the same `BrainMCPAgentRegistry`, carries the same per-tenant scope grant, and executes under the same `BrainSmartAccount` session-key model as any external agent. The only difference is a `provenance: "internal"` metadata field and that Brain operates the execution key. There is no separate native-agent path. See [Internal agents](../concepts/internal-agents.md).
{% endhint %}

### Agents Are First-Class Entities

Each agent has four attributes registered on-chain or referenced from on-chain.

| Attribute              | What It Is                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity**           | A `BrainMCPAgentRegistry` record on Base, keyed by an agent address (`agentId`/`tenantId`/`scopeHash`/`behaviorHash`)                                 |
| **Capability set**     | Declared at registration: `pay_invoice`, `rebalance_treasury`, `file_vat_return`, etc                                                                 |
| **Reputation history** | A per-agent reputation pointer / Merkle root in `BrainReputationRegistry` (RFC 0001, **UNAUDITED testnet**); read by Policy as a threshold input only |
| **Scope grants**       | Per-tenant EIP-712 attestations granting specific actions, limits, and durations                                                                      |

### Discovery and Routing

Tenants and other agents query the registry by capability and reputation.

```
Tenant: "I need to pay an invoice"
   ↓
Brain queries BrainMCPAgentRegistry
   ↓
Returns agents with capability = pay_invoice
   ↓
Brain selects based on:
   - capability match
   - policy compatibility
   - cost
   - historical performance (on-chain reputation via BrainReputationRegistry. RFC 0001, testnet)
   ↓
Selection itself is an audited event
```

[**→ Smart contract reference**](../smart-contracts/overview.md)

#### Category-aware selection

Some triggers match agents of different categories. `cash.balance_high`, for example, matches a business **Treasury** agent and a consumer **Savings** agent. The router resolves the tenant's category (business or consumer) and adds it to scoring: a candidate whose category matches the tenant is preferred, so a business tenant routes to Treasury and a consumer tenant routes to Savings.

A category mismatch is a **scoring downgrade, not a hard reject**. A mismatched agent can still be selected when it is the best or only match, so an explicit user intent overrides the default category preference. Agnostic agents (which serve both categories) take no penalty, and when no tenant category is resolved the router is category-blind.

#### Intent matching

When a request carries a free-form intent rather than a domain event, the router scores it against each agent's declared `intent_patterns`. Two classifier strategies share one interface, selected by the `AGENT_INTENT_CLASSIFIER` flag:

- **`rules`** (default). A deterministic token-overlap classifier. Fast and dependency-free, but it only matches phrasings that share words with a pattern.
- **`embedding`**. Embeds the intent and the patterns and scores by cosine similarity, so paraphrases match ("chase late-paying customers" routes to Collections even though it shares no tokens with "follow up on overdue invoice"). Pattern embeddings are cached and reindexed when the catalog changes.

The embedding classifier keeps the rules classifier as a **live fallback**: when an intent scores below the similarity threshold (or the embedding service is unavailable) the router falls back to token overlap. Selection scoring is unchanged. Only the source of the intent-match score differs.

### Three Execution Paths

Approved actions execute through one of three paths.

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🏦 Off-chain Rail</strong></td><td>A bank API or processor SDK called server-side by Brain on behalf of the tenant.</td><td></td></tr><tr><td><strong>⛓️ On-chain Via Smart Account</strong></td><td>The agent's granted session key calls <code>BrainSmartAccount.executeViaSessionKey</code>, enforced on-chain against its spend caps, bound <code>policyVersion</code>, and replay nonce.</td><td></td></tr><tr><td><strong>🤝 Agent-to-Agent</strong></td><td>An agent invokes another agent's capability through Brain. Both calls are policy-checked. Both are audited.</td><td></td></tr></tbody></table>

### Settlement: When Agents Are Paid

Where an external agent is paid for its work, Brain coordinates settlement so that the operator never redirects funds.

| Pattern                    | Mechanism                         | Use Case                                                                 |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| **Escrowed jobs**          | `BrainEscrow` (UNAUDITED testnet) | Multi-step work where USDC releases incrementally as milestones complete |
| **HTTP-native settlement** | x402                              | Per-call pay-per-use (an agent paying for an API call or tool call)      |

For x402 the tenant's smart account / EOA pays and the agent's address receives. For conditional work, the immutable `BrainEscrow` contract escrows USDC against a hashed job commitment and releases/refunds incrementally. The arbiter can only ever pay the designated payee or refund the designated payer, never redirect. Brain records and proves the flow.

**→ Escrow and x402 reference**

### SIWX Authentication

External agents authenticate using SIWX (Sign-In With X), based on EIP-4361 over Base.

```
1. Brain issues a structured SIWX challenge to the agent
2. Agent signs the challenge with its registered execution key
3. Brain verifies the signature, recovers the agent address
4. Brain looks up the address in BrainMCPAgentRegistry
5. Brain checks the agent's scope grants for the requesting tenant
6. Brain issues a session token with scoped capabilities
```

The session token gates every subsequent API or MCP call. Scopes that have not been granted by the tenant are simply invisible to the agent.

### EIP-712 ScopeAttestation

A scope grant is a tenant-signed authorization for a specific agent to perform a specific capability under specific limits. The EIP-712 type:

```
ScopeAttestation(
  bytes32 tenantId,
  address agent,
  bytes32 capability,        // e.g. keccak256("pay_invoice")
  uint128 maxAmount,
  bytes32 resourceScope,     // e.g. counterparty allowlist root
  uint64  notBefore,
  uint64  notAfter,
  uint256 nonce
)
```

This signed attestation is enforced off-chain (its hash is anchored as the agent's `scopeHash` in `BrainMCPAgentRegistry`). On-chain, the tenant translates the grant into a `BrainSmartAccount` session key via `grantSessionKey`, which binds the `policyVersion` and per-tx / per-period spend caps at grant time; `executeViaSessionKey` then enforces those caps, the bound `policyVersion`, and a per-holder replay nonce on every call.

### What Brain Provides vs What the Agent Provides

| Concern                             | Brain Provides                                                                          | Agent Provides |
| ----------------------------------- | --------------------------------------------------------------------------------------- | :------------: |
| **Verified financial context**      | ✅ Wiki + Ledger + citations                                                            |                |
| **Policy enforcement**              | ✅ Off-chain + on-chain                                                                 |                |
| **Identity and scope**              | ✅ `BrainMCPAgentRegistry`; reputation in `BrainReputationRegistry` (RFC 0001, testnet) |                |
| **Audit trail**                     | ✅ Hash chain + Merkle anchor                                                           |                |
| **Settlement infrastructure**       | ✅ Smart account, `BrainEscrow` (testnet), x402                                         |                |
| **Domain logic for the capability** |                                                                                         |       ✅       |
| **The actual work**                 |                                                                                         |       ✅       |

{% hint style="success" %}
This is why the Agent Layer is open. The substrate is general-purpose. The capabilities are pluggable.
{% endhint %}

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📐 Policy</strong></td><td>How agent actions are gated.</td><td><a href="policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>📜 BrainSmartAccount</strong></td><td>The session-key smart account that enforces spend caps and policy binding on every call.</td><td><a href="../smart-contracts/brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr><tr><td><strong>📜 BrainMCPAgentRegistry</strong></td><td>The agent identity contract.</td><td><a href="../smart-contracts/brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>
