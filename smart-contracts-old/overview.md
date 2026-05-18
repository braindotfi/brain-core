# Overview

## Smart Contracts Overview

Brain's on-chain surface is intentionally small. Most logic lives off-chain. On-chain contracts exist to anchor state, register identity, enforce ERC-4337 validation, and route agent execution.

<table><thead><tr><th width="200">Property</th><th>Value</th></tr></thead><tbody><tr><td><strong>Network</strong></td><td>Base L2</td></tr><tr><td><strong>Language</strong></td><td>Solidity 0.8.x</td></tr><tr><td><strong>Toolchain</strong></td><td>Foundry</td></tr><tr><td><strong>Upgrade pattern</strong></td><td>Transparent proxy with 48-hour timelock</td></tr><tr><td><strong>Audits</strong></td><td>Two independent audits before mainnet</td></tr><tr><td><strong>Bug bounty</strong></td><td>Public coverage</td></tr></tbody></table>

### The Four Core Contracts

<table data-view="cards"><thead><tr><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛡️ BrainAuditAnchor</strong></td><td>Stores Merkle roots of per-tenant audit batches. Immutable after submission.</td><td><a href="brainauditanchor.md">brainauditanchor.md</a></td></tr><tr><td><strong>📋 BrainPolicyRegistry</strong></td><td>Registers policy version hashes per tenant, signed via EIP-712.</td><td><a href="brainpolicyregistry.md">brainpolicyregistry.md</a></td></tr><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>ERC-4337 account validating UserOps against scope and policy verdict.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td></tr><tr><td><strong>🪪 BrainMCPAgentRegistry</strong></td><td>ERC-8004 compatible agent identity, capabilities, and reputation pointer.</td><td><a href="brainmcpagentregistry.md">brainmcpagentregistry.md</a></td></tr></tbody></table>

### Settlement Integrations

<table data-view="cards"><thead><tr><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📦 ERC-8183 Escrow</strong></td><td>Escrowed jobs and conditional payments for agent-paid work.</td><td><a href="escrow-and-x402.md#erc-8183-escrowed-job-flow">#erc-8183-escrowed-job-flow</a></td></tr><tr><td><strong>⚡ x402 Settlement</strong></td><td>HTTP-native machine payments for per-call API access.</td><td><a href="escrow-and-x402.md#x402-machine-native-payments">#x402-machine-native-payments</a></td></tr></tbody></table>

### Standards Composed

<table><thead><tr><th width="200">Standard</th><th>Role in Brain</th></tr></thead><tbody><tr><td><strong>ERC-4337</strong></td><td>Smart account model and UserOperation execution</td></tr><tr><td><strong>EIP-7702</strong></td><td>Delegated execution for EOAs (single-session lifetime)</td></tr><tr><td><strong>ERC-8004</strong></td><td>Agent identity, validation records, reputation root</td></tr><tr><td><strong>ERC-8183</strong></td><td>Escrowed jobs and conditional payments</td></tr><tr><td><strong>EIP-712</strong></td><td>Typed-data signatures for policies, scopes, approvals</td></tr><tr><td><strong>EIP-4361 (SIWX)</strong></td><td>Sign-In With X for agent authentication</td></tr><tr><td><strong>x402</strong></td><td>HTTP-native machine settlement</td></tr></tbody></table>

### Upgrade Safety

| Mechanism                               | Purpose                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| **Transparent proxy**                   | Upgradable implementation, immutable storage                   |
| **48-hour timelock**                    | Tenants and agents have time to react before upgrades activate |
| **Anchorer keys on HSMs**               | Roots cannot be anchored from compromised infrastructure       |
| **Strict monotonicity on `batchIndex`** | History cannot be silently rewritten                           |
| **Independent audits**                  | Two firms before mainnet, plus bug bounty                      |

{% hint style="info" %}
Most logic is off-chain by design. The on-chain surface is the smallest possible footprint required to anchor truth, register identity, and enforce ERC-4337 validation.
{% endhint %}

### Threat Model

| Trusted                                   | Untrusted                           |
| ----------------------------------------- | ----------------------------------- |
| The user's smart account contract code    | Any off-chain backend               |
| `BrainPolicyRegistry`, `BrainAuditAnchor` | Any RPC endpoint                    |
| The user's owner key                      | Any UI or hosted service            |
| Anchorer keys (HSM-protected)             | Any individual extractor or service |

Even if Brain's backend were fully compromised, an attacker would still need to produce a valid EIP-712 signature from a key that the on-chain contracts recognize. Stale verdicts expire. Reused nonces are rejected.
