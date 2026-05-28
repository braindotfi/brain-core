# BrainMCPAgentRegistry

`BrainMCPAgentRegistry` registers agents as a compact on-chain record: `agentId`, `agentAddress`, `tenantId`, `scopeHash`, and `behaviorHash`, each registration authorized by an EIP-712 signature from a tenant-allowlisted signer. On-chain reputation is planned, not yet implemented — see RFC 0001.

| Property     | Value                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| **Network**  | Base L2                                                                  |
| **Solidity** | 0.8.x                                                                    |
| **Pattern**  | Immutable — no upgrade path in MVP; changes ship as audited redeploys    |
| **Standard** | EIP-712 signed registration (ERC-8004 reputation planned — see RFC 0001) |

### Interface

This is the **deployed MVP surface**. Each lifecycle call carries an EIP-712 signature from a signer the tenant has allowlisted.

```solidity
contract BrainMCPAgentRegistry {
    struct AgentRegistration {
        bytes32 agentId;
        address agentAddress;
        bytes32 tenantId;
        bytes32 scopeHash;
        bytes32 behaviorHash;   // keccak256(model_id, model_version, prompt_template_hash, tool_manifest_hash)
        uint256 registeredAt;
        uint256 revokedAt;      // 0 while active
    }

    event AgentRegistered(
        bytes32 indexed agentId,
        address indexed agentAddress,
        bytes32 indexed tenantId,
        bytes32 scopeHash,
        bytes32 behaviorHash
    );
    event AgentRevoked(bytes32 indexed agentId, bytes32 indexed tenantId);
    event AgentBehaviorUpdated(bytes32 indexed agentId, bytes32 indexed tenantId, bytes32 behaviorHash);
    event TenantSignerSet(bytes32 indexed tenantId, address indexed signer, bool allowed);

    // A tenant must configure ≥1 allowlisted signer before any agent can be
    // registered for it; the first signer is bootstrapped by initialAdmin.
    function setTenantSigner(
        bytes32 tenantId, address signer, bool allowed,
        address authSigner, bytes calldata signature
    ) external;

    function registerAgent(
        bytes32 agentId, address agentAddress, bytes32 tenantId,
        bytes32 scopeHash, bytes32 behaviorHash, bytes calldata tenantSignature
    ) external;

    function updateBehaviorHash(
        bytes32 agentId, bytes32 behaviorHash, bytes calldata tenantSignature
    ) external;

    function revokeAgent(bytes32 agentId, bytes calldata tenantSignature) external;

    // Views
    function isAuthorized(bytes32 agentId, bytes32 tenantId) external view returns (bool);
    function getAgent(bytes32 agentId) external view returns (AgentRegistration memory);
    function isTenantSigner(bytes32 tenantId, address a) external view returns (bool);
}
```

The fuller ERC-8004 identity record (identity Merkle root, `mcpEndpoint`, capability-hash array) and per-capability scope grants are the **planned** target — see RFC 0001. Reputation is out of scope here and lives in [`BrainReputationRegistry`](brainreputationregistry.md).

### Agent Record

The deployed `AgentRegistration` struct stores exactly these fields:

| Field          | Purpose                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `agentId`      | Global agent identifier — the registry's primary key                                                                    |
| `agentAddress` | The agent's on-chain address                                                                                            |
| `tenantId`     | The tenant this registration is bound to                                                                                |
| `scopeHash`    | Hash of the agent's granted scope set; the agent's JWT `scope_hash` must equal this                                     |
| `behaviorHash` | `keccak256(model_id, model_version, prompt_template_hash, tool_manifest_hash)` — pins model/prompt/tools (§6 check 1.5) |
| `registeredAt` | Block timestamp at registration                                                                                         |
| `revokedAt`    | Block timestamp at revocation; `0` while active (`isAuthorized` reads this)                                             |

The fuller record below is the **planned** target — see RFC 0001. None of these fields exist in the deployed struct today:

| Planned field (RFC 0001) | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `identityRoot`           | ERC-8004 identity Merkle root (planned — RFC 0001)                      |
| `mcpEndpoint`            | URL where Brain can reach the agent over MCP                            |
| `capabilities[]`         | Hashes of capability identifiers (e.g., `keccak256("pay_invoice")`)     |
| `reputationRoot`         | Reputation pointer — now a separate contract, `BrainReputationRegistry` |

### Registration

Agents cannot self-register. A registration is authorized by a **tenant-allowlisted signer** who signs this EIP-712 message:

```
AgentRegistration(
  bytes32 agentId,
  address agentAddress,
  bytes32 tenantId,
  bytes32 scopeHash,
  bytes32 behaviorHash
)
```

```solidity
registry.registerAgent(agentId, agentAddress, tenantId, scopeHash, behaviorHash, tenantSignature);
```

The contract recovers the signer, rejects it unless it is on the tenant's allowlist (`isTenantSigner`), stores the record, and emits `AgentRegistered`.

### Per-Tenant Scoping

A tenant must first configure at least one allowlisted signer with `setTenantSigner` — the very first signer for a tenant is bootstrapped by `initialAdmin`, after which signers manage each other. Only an allowlisted signer can register, re-attest, or revoke an agent for that tenant.

Each registration binds the agent to exactly one `tenantId` plus a single `scopeHash` that encodes the whole granted scope set; the agent's JWT `scope_hash` must equal it. The predicate Brain consults before granting a session key is:

```solidity
registry.isAuthorized(agentId, tenantId); // true while registered, not revoked, and tenant matches
```

Finer-grained, per-capability scope grants (`grantScope`/`isScoped`) are the **planned** target — see RFC 0001. The MVP collapses scope into one signed `scopeHash`.

### Deactivation

```solidity
registry.revokeAgent(agentId, tenantSignature);
```

Revocation (signed by a tenant signer) sets `revokedAt` to the current block timestamp. `isAuthorized` then returns false, and Brain refuses to grant or use session keys for the agent. Revocation is permanent for that `agentId`; promoting a new model/prompt/tools instead uses `updateBehaviorHash`.

### Reputation lives in a separate contract

Reputation is **not** stored in this registry. It lives in [`BrainReputationRegistry`](brainreputationregistry.md) — an _ERC-8004-style_ per-agent pointer / Merkle root (RFC 0001, **UNAUDITED testnet**). This registry's deployed `AgentRegistration` struct stores only `agentId`, `agentAddress`, `tenantId`, `scopeHash`, and `behaviorHash` — there is **no** `reputationRoot` field here. Policy reads the reputation pointer as a **tighten-only threshold input**; it is never a money gate or a §6 precondition.

### Discovery

On-chain, the deployed registry answers per-id queries — `getAgent(agentId)` and `isAuthorized(agentId, tenantId)`. Richer discovery (by capability, by reputation standing) is resolved off-chain today; on-chain capability indexing is the planned target — see RFC 0001.

| Query                | Result                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Authorization        | `isAuthorized(agentId, tenantId)` — registered, not revoked, tenant matches                            |
| Capability filter    | Active agents declaring a capability (resolved off-chain; on-chain index planned — RFC 0001)           |
| Reputation threshold | Resolved via `BrainReputationRegistry` (testnet); Policy maps the pointer to a minimum score off-chain |

{% hint style="success" %}
Discovery is itself audited. Brain logs every selection event so a tenant can later verify why a particular agent was chosen.
{% endhint %}

### ERC-8004 Alignment (RFC 0001)

{% hint style="info" %}
The deployed registry stores identity + scope as `agentId`/`tenantId`/`scopeHash`/`behaviorHash` hashes. The _reputation_ half of ERC-8004 alignment is now a separate (RFC 0001, **UNAUDITED testnet**) contract, `BrainReputationRegistry`.
{% endhint %}

| ERC-8004 concept (RFC 0001) | Brain Implementation                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| **Identity record**         | `BrainMCPAgentRegistry` — `agentId` / `tenantId` / `scopeHash` / `behaviorHash` |
| **Reputation root**         | `BrainReputationRegistry.scoreRoot` per agent (testnet)                         |
| **Validation records**      | Committed off-chain under the reputation `scoreRoot` (testnet)                  |
| **Discovery**               | View functions across both registries                                           |

## behaviorHash Pinning

`registerAgent` now also takes a `behaviorHash = keccak256(model_id, model_version, prompt_template_hash, tool_manifest_hash)`, emitted on `AgentRegistered` and stored on the registration. This freezes the agent's behavior at a known version — enterprise security teams get a "the agent cannot silently change its model/prompt/tools" guarantee.

- The §6 gate adds **check 1.5**: the runtime `behaviorHash` must equal the registered value, or the action is rejected regardless of every other signal.
- Promotion to a new behavior requires fresh tenant re-attestation via `updateBehaviorHash(agentId, behaviorHash, tenantSignature)` (EIP-712 signed by a tenant signer) — the on-chain analogue of re-signing the ScopeAttestation.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🤖 Agents</strong></td><td>The conceptual model.</td><td><a href="../concepts/agents.md">agents.md</a></td><td></td></tr><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>How `isAuthorized()` gates session-key grants.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr><tr><td><strong>🌐 Agents API</strong></td><td>Register and scope agents over HTTP.</td><td><a href="../api-reference/agents-api.md">agents-api.md</a></td><td></td></tr></tbody></table>
