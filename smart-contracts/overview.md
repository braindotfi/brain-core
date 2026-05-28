# Overview

Brain's on-chain surface is intentionally small. Most logic lives off-chain. On-chain contracts exist to anchor state, register identity, enforce session-key scope and spend caps, and route agent execution.

| Property            | Value                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network**         | Base L2                                                                                                                                                               |
| **Language**        | Solidity 0.8.x                                                                                                                                                        |
| **Toolchain**       | Foundry                                                                                                                                                               |
| **Upgrade pattern** | Immutable. No upgrade path in MVP; changes ship as audited redeploys                                                                                                 |
| **Audits**          | External security audit required before mainnet. The escrow + reputation contracts are **UNAUDITED** and run on **Base Sepolia testnet** only until that audit clears |
| **Bug bounty**      | Public coverage                                                                                                                                                       |

### Core Contracts

The four core contracts. (The escrow + reputation contracts below are newer **UNAUDITED testnet** reference implementations.)

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛡️ BrainAuditAnchor</strong></td><td>Stores Merkle roots of per-tenant audit batches. Immutable after submission.</td><td><a href="brainauditanchor.md">brainauditanchor.md</a></td><td></td></tr><tr><td><strong>📋 BrainPolicyRegistry</strong></td><td>Registers policy version hashes per tenant, signed via EIP-712.</td><td><a href="brainpolicyregistry.md">brainpolicyregistry.md</a></td><td></td></tr><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>Per-tenant session-key smart account; <code>executeViaSessionKey</code> enforces scope, spend caps, and the bound <code>policyVersion</code> on-chain. Immutable.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr><tr><td><strong>🪪 BrainMCPAgentRegistry</strong></td><td>Stores agent identity and scope as <code>agentId</code>/<code>tenantId</code>/<code>scopeHash</code>/<code>behaviorHash</code> hashes. Reputation now lives in a separate contract (BrainReputationRegistry).</td><td><a href="brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>

### Settlement & Reputation (UNAUDITED. Base Sepolia testnet reference contracts)

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📦 BrainEscrow</strong></td><td>Custodial USDC escrow for conditional M2M settlement: lock against a hashed job commitment, then <strong>incremental</strong> release/refund (milestones + arbiter dispute-splits). UNAUDITED, testnet only.</td><td><a href="escrow-and-x402.md">escrow-and-x402.md</a></td><td></td></tr><tr><td><strong>🏅 BrainReputationRegistry</strong></td><td>ERC-8004-style per-agent reputation <strong>pointer</strong> (Merkle root); read by Policy as a tighten-only threshold input. Never a money gate. Non-custodial. UNAUDITED, testnet only.</td><td><a href="brainreputationregistry.md">brainreputationregistry.md</a></td><td></td></tr><tr><td><strong>⚡ x402 Settlement</strong></td><td>HTTP-native machine payments (USDC on Base) for per-call API access, settled through the §6 gate.</td><td><a href="escrow-and-x402.md">escrow-and-x402.md</a></td><td></td></tr></tbody></table>

### Standards Composed

| Standard                      | Role in Brain                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session-key smart account** | Owner-granted scoped, spend-capped, policyVersion-bound keys; `executeViaSessionKey` enforces the bounds on-chain                                                    |
| **EIP-7702**                  | _Planned (RFC 0001)_. Delegated execution for EOAs (single-session lifetime); not shipped in MVP                                                                    |
| **ERC-8004**                  | _ERC-8004-style_. `BrainReputationRegistry` (RFC 0001, **UNAUDITED testnet**): a per-agent reputation pointer/Merkle root, read by Policy as a threshold input only |
| **BrainEscrow**               | Custodial USDC escrow for conditional M2M settlement. Incremental release/refund (RFC 0001, **UNAUDITED testnet**). A custom hash-only contract, not ERC-8183.      |
| **EIP-712**                   | Typed-data signatures for policies, scopes, approvals                                                                                                                |
| **EIP-4361 (SIWX)**           | Sign-In With X for agent authentication                                                                                                                              |
| **x402**                      | HTTP-native machine settlement                                                                                                                                       |

### Operational Safety

| Mechanism                               | Purpose                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- |
| **Immutable contracts**                 | No upgrade path in MVP; any change ships as a separately audited redeploy |
| **Anchorer keys on HSMs**               | Roots cannot be anchored from compromised infrastructure                  |
| **Strict monotonicity on `batchIndex`** | History cannot be silently rewritten                                      |
| **External audit**                      | Required before any mainnet deployment, plus a public bug bounty          |

{% hint style="info" %}
Most logic is off-chain by design. The on-chain surface is the smallest possible footprint required to anchor truth, register identity, and enforce session-key scope and spend caps.
{% endhint %}

### Threat Model

| Trusted                                   | Untrusted                           |
| ----------------------------------------- | ----------------------------------- |
| The user's smart account contract code    | Any off-chain backend               |
| `BrainPolicyRegistry`, `BrainAuditAnchor` | Any RPC endpoint                    |
| The user's owner key                      | Any UI or hosted service            |
| Anchorer keys (HSM-protected)             | Any individual extractor or service |

Even if Brain's backend were fully compromised, an attacker would still need to produce a valid EIP-712 signature from a key the on-chain contracts recognize. Stale verdicts expire. Reused nonces are rejected.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛡️ BrainAuditAnchor</strong></td><td>Merkle anchoring for audit history.</td><td><a href="brainauditanchor.md">brainauditanchor.md</a></td><td></td></tr><tr><td><strong>📋 BrainPolicyRegistry</strong></td><td>Policy version hashes on-chain.</td><td><a href="brainpolicyregistry.md">brainpolicyregistry.md</a></td><td></td></tr><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>Session-key account with policy and scope checks.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr></tbody></table>
