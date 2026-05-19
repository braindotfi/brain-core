# BrainPolicyRegistry

`BrainPolicyRegistry` registers policy version hashes per tenant. The policy text and compiled rules live off-chain. Only the canonical hash is on-chain, signed by the tenant.

| Property           | Value                                           |
| ------------------ | ----------------------------------------------- |
| **Network**        | Base L2                                         |
| **Solidity**       | 0.8.x                                           |
| **Pattern**        | Transparent proxy with 48-hour upgrade timelock |
| **Tenant signing** | EIP-712 `PolicyRegistration`                    |

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

### EIP-712 type

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

| Field                   | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `tenantId`              | The tenant the policy belongs to                   |
| `version`               | Monotonically increasing version number            |
| `policyHash`            | SHA-256 hash of the canonical compiled policy JSON |
| `notBefore`, `notAfter` | Validity window                                    |
| `nonce`                 | Replay protection                                  |

### Lifecycle

```
draft → compile → review → sign (EIP-712) → registerPolicy() → active
```

| Phase        | Where                                          |
| ------------ | ---------------------------------------------- |
| **Draft**    | Console or API                                 |
| **Compile**  | Off-chain Policy compiler                      |
| **Review**   | Tenant reviews compiled JSON plus explanation  |
| **Sign**     | Tenant signs `PolicyRegistration`              |
| **Register** | `registerPolicy()` called on Base              |
| **Active**   | Until superseded by a newer version or revoked |

### What is on-chain vs off-chain

| On-chain                | Off-chain                 |
| ----------------------- | ------------------------- |
| `tenantId` (hashed)     | Tenant raw identifier     |
| `version`               | Plain-English policy text |
| `policyHash`            | Compiled JSON rules       |
| `notBefore`, `notAfter` | Compiler explanation      |
| Signer address          | Diff between versions     |

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

### Active policy lookup

```solidity
(uint64 version, bytes32 hash) = registry.activePolicy(tenantId);
```

`BrainSmartAccount` uses this lookup during UserOp validation: the policy verdict attached to the UserOp must reference the active version's hash, or the UserOp is rejected.

### Versioning rules

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

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📋 Policy and Permissioning</strong></td><td>The conceptual model.</td><td><a href="../protocol/policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>🌐 Policy API</strong></td><td>HTTP reference for policy operations.</td><td><a href="../api-reference/policy-api.md">policy-api.md</a></td><td></td></tr><tr><td><strong>🔐 BrainSmartAccount</strong></td><td>How policy verdicts are validated on UserOps.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr></tbody></table>
