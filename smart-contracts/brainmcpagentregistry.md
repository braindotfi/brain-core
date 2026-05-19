# BrainMCPAgentRegistry

`BrainMCPAgentRegistry` registers agents, their capabilities, their MCP endpoints, and their reputation pointers. The contract is ERC-8004 compatible.

| Property     | Value                                                  |
| ------------ | ------------------------------------------------------ |
| **Network**  | Base L2                                                |
| **Solidity** | 0.8.x                                                  |
| **Pattern**  | Transparent proxy with 48-hour upgrade timelock        |
| **Standard** | ERC-8004 compatible (identity, validation, reputation) |

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

### Agent record

| Field            | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `addr`           | The agent's on-chain address                                        |
| `identityRoot`   | ERC-8004 identity Merkle root                                       |
| `mcpEndpoint`    | URL where Brain can reach the agent over MCP                        |
| `capabilities[]` | Hashes of capability identifiers (e.g., `keccak256("pay_invoice")`) |
| `reputationRoot` | Merkle root over signed performance attestations                    |
| `registeredAt`   | Block timestamp at registration                                     |
| `active`         | Whether the agent is enabled                                        |

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

### Per-tenant scoping

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

| Component        | Detail                                                                             |
| ---------------- | ---------------------------------------------------------------------------------- |
| **Attestation**  | Signed (EIP-712) by a tenant after a successful or failed action                   |
| **Aggregation**  | Off-chain service builds a Merkle tree per agent                                   |
| **Commitment**   | The root is updated on-chain via a separate update path                            |
| **Verification** | A tenant verifying an attestation supplies a Merkle proof against `reputationRoot` |

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

| Query                | Result                                                            |
| -------------------- | ----------------------------------------------------------------- |
| Capability filter    | All active agents that have declared this capability              |
| Reputation threshold | Agents with `reputationRoot` mapping to a minimum score off-chain |
| Combined             | Capability filter intersected with reputation threshold           |

{% hint style="success" %}
Discovery is itself audited. Brain logs every selection event so a tenant can later verify why a particular agent was chosen.
{% endhint %}

### ERC-8004 alignment

| ERC-8004 Concept       | Brain's Implementation                                 |
| ---------------------- | ------------------------------------------------------ |
| **Identity record**    | `identityRoot` per agent                               |
| **Validation records** | Signed performance attestations under `reputationRoot` |
| **Reputation root**    | `reputationRoot` per agent                             |
| **Discovery**          | View functions on the registry                         |

The contract is a thin layer over ERC-8004 with Brain-specific fields for MCP endpoint and explicit per-tenant scoping.

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🤖 Agents</strong></td><td>The conceptual model.</td><td><a href="../concepts/agents.md">agents.md</a></td><td></td></tr><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>How `isScoped()` is checked during UserOp validation.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr><tr><td><strong>🌐 Agents API</strong></td><td>Register and scope agents over HTTP.</td><td><a href="../api-reference/agents-api.md">agents-api.md</a></td><td></td></tr></tbody></table>
