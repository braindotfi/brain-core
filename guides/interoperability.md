---
hidden: true
---

# Interoperability

Brain's standards-based design ensures maximum compatibility with existing wallets, infrastructure providers, and applications. No bespoke integrations required.

## Interoperability Flow

{% stepper %}
{% step %}
### Verify agent identity

External apps call the ERC-8004 registry to retrieve `agentId`, execution address, metadata, status, and reputation. No Brain SDK required.
{% endstep %}

{% step %}
### Discover account capabilities

Apps query the Brain smart account using ERC-7902-compatible methods to discover supported features, policy hooks, and account abstraction details.
{% endstep %}

{% step %}
### Submit UserOperations

Standard ERC-4337 infrastructure (EntryPoint + ERC-7769-compatible bundler) handles Brain UserOperations without custom modifications.
{% endstep %}

{% step %}
### EOA delegation (optional)

If the user operates via an existing EOA, EIP-7702 delegation is used instead of a full smart account migration.
{% endstep %}

{% step %}
### Payment and commerce

Payments are handled via x402 HTTP flows or ERC-8183 JobEscrow contracts, depending on whether the interaction is a simple API call or a multi-step workflow.
{% endstep %}
{% endstepper %}

## Compatible Infrastructure

<table><thead><tr><th width="150.2265625">Category</th><th>Compatible With</th></tr></thead><tbody><tr><td>Bundlers</td><td>Any ERC-7769 / ERC-4337 compatible bundler (Alchemy, Pimlico, etc.)</td></tr><tr><td>Wallets</td><td>Any wallet supporting ERC-7902 capability discovery</td></tr><tr><td>Networks</td><td>Base (primary), Ethereum (settlement and identity anchor)</td></tr><tr><td>RPC</td><td>Alchemy and any standard JSON-RPC provider</td></tr><tr><td>AI Services</td><td>Any API supporting x402 payment headers (OpenAI, Anthropic, etc.)</td></tr></tbody></table>

## Integrating Without the Brain SDK

External systems can interact with Brain agents using only open standards:

```solidity
// Verify an agent's identity and reputation — no Brain SDK needed
IAgentRegistry registry = IAgentRegistry(ERC8004_REGISTRY_ADDRESS);

bytes32 agentId = registry.getAgentId(agentAddress);
uint256 reputation = registry.getReputation(agentAddress);
AgentStatus status = registry.getStatus(agentAddress);

require(status == AgentStatus.Active, "Agent not active");
require(reputation >= MIN_REPUTATION_THRESHOLD, "Insufficient reputation");
```

```typescript
// Discover Brain account capabilities — standard ERC-7902 wallet call
const capabilities = await provider.send('wallet_getCapabilities', [
  brainAccountAddress,
]);
// Returns supported methods, policy hooks, agent abstraction features
```

## Multi-Chain Considerations

Brain uses a two-network model:

<table><thead><tr><th width="149.55078125">Network</th><th>Purpose</th></tr></thead><tbody><tr><td><strong>Base</strong></td><td>Execution — agent actions, x402 payments, ERC-8183 jobs</td></tr><tr><td><strong>Ethereum</strong></td><td>Settlement and identity — ERC-8004 registry, high-value finality</td></tr></tbody></table>

Agent `agentId` values are chain-agnostic (ERC-8004), meaning the same identity can be referenced across chains. Cross-chain settlement flows use Ethereum as the canonical record.

{% hint style="info" %}
Brain's interoperability approach means external systems can evaluate agents, submit transactions, and receive payments using only open standards — without depending on Brain-specific SDKs or centralized platforms.
{% endhint %}
