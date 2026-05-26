# Overview

Brain's on-chain surface is intentionally small. Most logic lives off-chain. On-chain contracts exist to anchor state, register identity, enforce session-key scope and spend caps, and route agent execution.

| Property            | Value                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| **Network**         | Base L2                                                               |
| **Language**        | Solidity 0.8.x                                                        |
| **Toolchain**       | Foundry                                                               |
| **Upgrade pattern** | Immutable — no upgrade path in MVP; changes ship as audited redeploys |
| **Audits**          | Two independent audits before mainnet                                 |
| **Bug bounty**      | Public coverage                                                       |

### The Four Core Contracts

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛡️ BrainAuditAnchor</strong></td><td>Stores Merkle roots of per-tenant audit batches. Immutable after submission.</td><td><a href="brainauditanchor.md">brainauditanchor.md</a></td><td></td></tr><tr><td><strong>📋 BrainPolicyRegistry</strong></td><td>Registers policy version hashes per tenant, signed via EIP-712.</td><td><a href="brainpolicyregistry.md">brainpolicyregistry.md</a></td><td></td></tr><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>Per-tenant session-key smart account; <code>executeViaSessionKey</code> enforces scope, spend caps, and the bound <code>policyVersion</code> on-chain. Immutable.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr><tr><td><strong>🪪 BrainMCPAgentRegistry</strong></td><td>Stores agent identity and scope as <code>agentId</code>/<code>tenantId</code>/<code>scopeHash</code>/<code>behaviorHash</code> hashes. On-chain reputation is planned — see RFC 0001.</td><td><a href="brainmcpagentregistry.md">brainmcpagentregistry.md</a></td><td></td></tr></tbody></table>

### Settlement Integrations

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📦 ERC-8183 Escrow</strong></td><td>Escrowed jobs and conditional payments for agent-paid work.</td><td><a href="escrow-and-x402.md">escrow-and-x402.md</a></td><td></td></tr><tr><td><strong>⚡ x402 Settlement</strong></td><td>HTTP-native machine payments for per-call API access.</td><td><a href="escrow-and-x402.md">escrow-and-x402.md</a></td><td></td></tr></tbody></table>

### Standards Composed

| Standard                      | Role in Brain                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Session-key smart account** | Owner-granted scoped, spend-capped, policyVersion-bound keys; `executeViaSessionKey` enforces the bounds on-chain                       |
| **EIP-7702**                  | _Planned (RFC 0001)_ — delegated execution for EOAs (single-session lifetime); not shipped in MVP                                       |
| **ERC-8004**                  | _Planned (RFC 0001)_ — agent identity, validation records, reputation root; the MVP registry stores identity/scope/behavior hashes only |
| **ERC-8183**                  | Escrowed jobs and conditional payments                                                                                                  |
| **EIP-712**                   | Typed-data signatures for policies, scopes, approvals                                                                                   |
| **EIP-4361 (SIWX)**           | Sign-In With X for agent authentication                                                                                                 |
| **x402**                      | HTTP-native machine settlement                                                                                                          |

### Operational Safety

| Mechanism                               | Purpose                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- |
| **Immutable contracts**                 | No upgrade path in MVP; any change ships as a separately audited redeploy |
| **Anchorer keys on HSMs**               | Roots cannot be anchored from compromised infrastructure                  |
| **Strict monotonicity on `batchIndex`** | History cannot be silently rewritten                                      |
| **Independent audits**                  | Two firms before mainnet, plus bug bounty                                 |

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
