# BrainMCPAgentRegistry

`BrainMCPAgentRegistry` registers agents as a compact on-chain record: `agentId`, `agentAddress`, `tenantId`, `scopeHash`, and `behaviorHash`, each registration authorized by an EIP-712 signature from a tenant-allowlisted signer. On-chain reputation is planned, not yet implemented — see RFC 0001.

| Property     | Value                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| **Network**  | Base L2                                                                  |
| **Solidity** | 0.8.x                                                                    |
| **Pattern**  | Immutable — no upgrade path in MVP; changes ship as audited redeploys    |
| **Standard** | EIP-712 signed registration (ERC-8004 reputation planned — see RFC 0001) |

### Interface

```solidity
interface IBrainMCPAgentRegistry {
    struct Agent {
        address  addr;
        bytes32  identityRoot;     // ERC-8004 (planned — RFC 0001)
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

The deployed MVP record is `agentId`, `agentAddress`, `tenantId`, `scopeHash`, and `behaviorHash`. The fuller record below (identity/reputation roots, MCP endpoint, capability hashes) is the planned target — see RFC 0001.

| Field            | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `addr`           | The agent's on-chain address                                        |
| `identityRoot`   | ERC-8004 identity Merkle root (planned — RFC 0001)                  |
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

`isScoped()` is the predicate Brain consults before granting a session key to an agent.

### Deactivation

```solidity
registry.deactivateAgent(agent, ownerSig);
```

Deactivation flips `active` to false. Brain refuses to grant or use session keys for a deactivated agent. Existing scope grants for this agent stop matching `isScoped()`.

### Reputation (planned — RFC 0001)

{% hint style="info" %}
On-chain reputation is **not implemented in the MVP**. The deployed `AgentRegistration` struct stores `agentId`, `agentAddress`, `tenantId`, `scopeHash`, and `behaviorHash` only — there is no `reputationRoot` field. The design below is the roadmap target tracked in RFC 0001.
{% endhint %}

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

### ERC-8004 Alignment (planned — RFC 0001)

{% hint style="info" %}
ERC-8004 compatibility is a roadmap target (RFC 0001), not an MVP guarantee. The deployed contract stores identity and scope as `agentId`/`tenantId`/`scopeHash`/`behaviorHash` hashes; the mapping below describes the planned alignment.
{% endhint %}

| ERC-8004 Concept       | Planned Brain Implementation                           |
| ---------------------- | ------------------------------------------------------ |
| **Identity record**    | `identityRoot` per agent                               |
| **Validation records** | Signed performance attestations under `reputationRoot` |
| **Reputation root**    | `reputationRoot` per agent                             |
| **Discovery**          | View functions on the registry                         |

The MVP registry is a compact identity/scope/behavior record; full ERC-8004 alignment (reputation, validation records) is planned per RFC 0001.

## behaviorHash Pinning

`registerAgent` now also takes a `behaviorHash = keccak256(model_id, model_version, prompt_template_hash, tool_manifest_hash)`, emitted on `AgentRegistered` and stored on the registration. This freezes the agent's behavior at a known version — enterprise security teams get a "the agent cannot silently change its model/prompt/tools" guarantee.

- The §6 gate adds **check 1.5**: the runtime `behaviorHash` must equal the registered value, or the action is rejected regardless of every other signal.
- Promotion to a new behavior requires fresh tenant re-attestation via `updateBehaviorHash(agentId, behaviorHash, tenantSignature)` (EIP-712 signed by a tenant signer) — the on-chain analogue of re-signing the ScopeAttestation.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🤖 Agents</strong></td><td>The conceptual model.</td><td><a href="../concepts/agents.md">agents.md</a></td><td></td></tr><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>How `isScoped()` gates session-key grants.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr><tr><td><strong>🌐 Agents API</strong></td><td>Register and scope agents over HTTP.</td><td><a href="../api-reference/agents-api.md">agents-api.md</a></td><td></td></tr></tbody></table>
