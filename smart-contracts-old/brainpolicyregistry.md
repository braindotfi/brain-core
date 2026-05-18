# BrainPolicyRegistry

`BrainPolicyRegistry` registers policy version hashes per tenant. The policy text and compiled rules live off-chain. Only the canonical hash is on-chain, signed by the tenant.

<table><thead><tr><th width="200">Property</th><th>Value</th></tr></thead><tbody><tr><td><strong>Network</strong></td><td>Base L2</td></tr><tr><td><strong>Solidity</strong></td><td>0.8.x</td></tr><tr><td><strong>Pattern</strong></td><td>Transparent proxy with 48-hour upgrade timelock</td></tr><tr><td><strong>Tenant signing</strong></td><td>EIP-712 <code>PolicyRegistration</code></td></tr></tbody></table>

### Interface

```solidity
interface IBrainPolicyRegistry {
    event PolicyRegistered(
        bytes32 indexed tenantId,
        uint64  indexed version,
        bytes32 policyHash,
        address signer
    );
    event PolicyRevoked(
        bytes32 indexed tenantId,
        uint64  indexed version
    );

    function registerPolicy(
        bytes32 tenantId,
        uint64  version,
        bytes32 policyHash,
        bytes   calldata tenantSig  // EIP-712 PolicyRegistration
    ) external;

    function revokePolicy(
        bytes32 tenantId,
        uint64  version,
        bytes   calldata tenantSig
    ) external;

    function activePolicy(bytes32 tenantId)
        external view returns (uint64 version, bytes32 policyHash);
}
```

### EIP-712 Type

Tenants sign the canonical hash, not the prose.

```
PolicyRegistration(
  bytes32 tenantId,
  uint64  version,
  bytes32 policyHash,
  uint64  notBefore,
  uint64  notAfter,
  uint256 nonce
)
```

<table><thead><tr><th width="250">Field</th><th>Purpose</th></tr></thead><tbody><tr><td><code>tenantId</code></td><td>The tenant the policy belongs to</td></tr><tr><td><code>version</code></td><td>Monotonically increasing version number</td></tr><tr><td><code>policyHash</code></td><td>SHA-256 hash of the canonical compiled policy JSON</td></tr><tr><td><code>notBefore</code>, <code>notAfter</code></td><td>Validity window</td></tr><tr><td><code>nonce</code></td><td>Replay protection</td></tr></tbody></table>

### Lifecycle

```
draft → compile → review → sign (EIP-712) → registerPolicy() → active
```

<table><thead><tr><th width="250">Phase</th><th>Where</th></tr></thead><tbody><tr><td><strong>Draft</strong></td><td>Console or API</td></tr><tr><td><strong>Compile</strong></td><td>Off-chain Policy compiler</td></tr><tr><td><strong>Review</strong></td><td>Tenant reviews compiled JSON plus explanation</td></tr><tr><td><strong>Sign</strong></td><td>Tenant signs <code>PolicyRegistration</code></td></tr><tr><td><strong>Register</strong></td><td><code>registerPolicy()</code> called on Base</td></tr><tr><td><strong>Active</strong></td><td>Until superseded by a newer version or revoked</td></tr></tbody></table>

### What is On-chain vs Off-Chain

<table><thead><tr><th width="250">On-chain</th><th>Off-chain</th></tr></thead><tbody><tr><td><code>tenantId</code> (hashed)</td><td>Tenant raw identifier</td></tr><tr><td><code>version</code></td><td>Plain-English policy text</td></tr><tr><td><code>policyHash</code></td><td>Compiled JSON rules</td></tr><tr><td><code>notBefore</code>, <code>notAfter</code></td><td>Compiler explanation</td></tr><tr><td>Signer address</td><td>Diff between versions</td></tr></tbody></table>

{% hint style="info" %}
The policy text is private to the tenant. Only its hash is anchored. A counterparty verifying a policy verdict checks that the verdict references a hash registered on-chain, not the policy text itself.
{% endhint %}

### Revocation

```solidity
revokePolicy(
  bytes32 tenantId,
  uint64  version,
  bytes   calldata tenantSig
);
```

Revoking a version disables it immediately. The tenant must register a new active version before further policy-gated actions can run.

### Active Policy Lookup

```solidity
(uint64 version, bytes32 hash) = registry.activePolicy(tenantId);
```

`BrainSmartAccount` uses this lookup during UserOp validation: the policy verdict attached to the UserOp must reference the active version's hash, or the UserOp is rejected.

### Versioning Rules

| Rule                                                                            | Detail                            |
| ------------------------------------------------------------------------------- | --------------------------------- |
| `version` must increase                                                         | Replays of older versions revert  |
| `notBefore` must be in the future                                               | At submission time                |
| `notAfter` must be after `notBefore`                                            | Validity window must be non-empty |
| Active policy is the highest non-revoked version with a current validity window | Resolved on every UserOp          |

### Privacy

The on-chain footprint is intentionally minimal. The hash commits to the policy without revealing it.

| Mechanism                                        | Effect                                                    |
| ------------------------------------------------ | --------------------------------------------------------- |
| `tenantId` is hashed before storage              | Cross-tenant correlation is hard                          |
| `policyHash` is SHA-256 of compiled JSON         | The structure is hidden                                   |
| Off-chain logic enforces canonical serialization | Two compilations of the same policy produce the same hash |
