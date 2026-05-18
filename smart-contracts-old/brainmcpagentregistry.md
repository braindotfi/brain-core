# BrainMCPAgentRegistry

`BrainMCPAgentRegistry` registers agents, their capabilities, their MCP endpoints, and their reputation pointers. The contract is ERC-8004 compatible.

<table><thead><tr><th width="200">Property</th><th>Value</th></tr></thead><tbody><tr><td><strong>Network</strong></td><td>Base L2</td></tr><tr><td><strong>Solidity</strong></td><td>0.8.x</td></tr><tr><td><strong>Pattern</strong></td><td>Transparent proxy with 48-hour upgrade timelock</td></tr><tr><td><strong>Standard</strong></td><td>ERC-8004 compatible (identity, validation, reputation)</td></tr></tbody></table>

### Interface

```solidity
interface IBrainMCPAgentRegistry {
    struct Agent {
        address  addr;
        bytes32  identityRoot;     // ERC-8004
        string   mcpEndpoint;      // https://...
        bytes32[] capabilities;
        bytes32  reputationRoot;
        uint64   registeredAt;
        bool     active;
    }

    event AgentRegistered(address indexed agent, bytes32 identityRoot);
    event AgentDeactivated(address indexed agent);
    event AgentScoped(
        bytes32 indexed tenantId,
        address indexed agent,
        bytes32 capability
    );

    function registerAgent(Agent calldata a, bytes calldata ownerSig) external;

    function deactivateAgent(address agent, bytes calldata ownerSig) external;

    function grantScope(
        bytes32 tenantId,
        address agent,
        bytes32 capability,
        bytes calldata tenantSig    // EIP-712 ScopeGrant
    ) external;

    function isScoped(
        bytes32 tenantId, address agent, bytes32 capability
    ) external view returns (bool);

    function getAgent(address agent) external view returns (Agent memory);
}
```

### Agent Record

<table><thead><tr><th width="200">Field</th><th>Purpose</th></tr></thead><tbody><tr><td><code>addr</code></td><td>The agent's on-chain address</td></tr><tr><td><code>identityRoot</code></td><td>ERC-8004 identity Merkle root</td></tr><tr><td><code>mcpEndpoint</code></td><td>URL where Brain can reach the agent over MCP</td></tr><tr><td><code>capabilities[]</code></td><td>Hashes of capability identifiers (e.g., <code>keccak256("pay_invoice")</code>)</td></tr><tr><td><code>reputationRoot</code></td><td>Merkle root over signed performance attestations</td></tr><tr><td><code>registeredAt</code></td><td>Block timestamp at registration</td></tr><tr><td><code>active</code></td><td>Whether the agent is enabled</td></tr></tbody></table>

### Registration

Agent owners sign an EIP-712 message authorizing registration:

```
AgentRegistration(
  address  agent,
  bytes32  identityRoot,
  string   mcpEndpoint,
  bytes32[] capabilities,
  uint256  nonce
)
```

```solidity
registry.registerAgent(agentRecord, ownerSig);
```

The contract verifies the signature, stores the record, and emits `AgentRegistered`.

### Per-Tenant Scoping

Registration alone does not authorize an agent to act for any tenant. A tenant must explicitly grant scope per capability.

```
ScopeGrant(
  bytes32 tenantId,
  address agent,
  bytes32 capability,
  uint64  notBefore,
  uint64  notAfter,
  uint256 nonce
)
```

```solidity
registry.grantScope(tenantId, agent, capability, tenantSig);
```

`isScoped()` is the predicate `BrainSmartAccount` consults during UserOp validation.

### Deactivation

```solidity
registry.deactivateAgent(agent, ownerSig);
```

Deactivation flips `active` to false. Subsequent UserOps from this agent are rejected at the `BrainSmartAccount` level. Existing scope grants for this agent stop matching `isScoped()`.

### Reputation

Reputation is stored off-chain and committed as a Merkle root per agent.

```
        reputationRoot
       /              \
   batch_h1         batch_h2
   /     \          /     \
 att_a  att_b   att_c   att_d
```

<table><thead><tr><th width="200">Component</th><th>Detail</th></tr></thead><tbody><tr><td><strong>Attestation</strong></td><td>Signed (EIP-712) by a tenant after a successful or failed action</td></tr><tr><td><strong>Aggregation</strong></td><td>Off-chain service builds a Merkle tree per agent</td></tr><tr><td><strong>Commitment</strong></td><td>The root is updated on-chain via a separate update path</td></tr><tr><td><strong>Verification</strong></td><td>A tenant verifying an attestation supplies a Merkle proof against <code>reputationRoot</code></td></tr></tbody></table>

```
ReputationAttestation(
  bytes32 tenantId,
  address agent,
  bytes32 actionId,
  bool    success,
  uint64  timestamp,
  uint256 nonce
)
```

### Discovery

Tenants and other agents query the registry to discover agents by capability and reputation.

<table><thead><tr><th width="200">Query</th><th>Result</th></tr></thead><tbody><tr><td>Capability filter</td><td>All active agents that have declared this capability</td></tr><tr><td>Reputation threshold</td><td>Agents with <code>reputationRoot</code> mapping to a minimum score off-chain</td></tr><tr><td>Combined</td><td>Capability filter intersected with reputation threshold</td></tr></tbody></table>

{% hint style="success" %}
Discovery is itself audited. Brain logs every selection event so a tenant can later verify why a particular agent was chosen.
{% endhint %}

### ERC-8004 Alignment

<table><thead><tr><th width="200">ERC-8004 Concept</th><th>Brain's Implementation</th></tr></thead><tbody><tr><td><strong>Identity record</strong></td><td><code>identityRoot</code> per agent</td></tr><tr><td><strong>Validation records</strong></td><td>Signed performance attestations under <code>reputationRoot</code></td></tr><tr><td><strong>Reputation root</strong></td><td><code>reputationRoot</code> per agent</td></tr><tr><td><strong>Discovery</strong></td><td>View functions on the registry</td></tr></tbody></table>

The contract is a thin layer over ERC-8004 with Brain-specific fields for MCP endpoint and explicit per-tenant scoping.
