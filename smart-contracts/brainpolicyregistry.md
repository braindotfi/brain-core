# BrainPolicyRegistry

`BrainPolicyRegistry` registers policy version hashes per tenant. The policy text and compiled rules live off-chain. Only the canonical hash is on-chain, signed by the tenant.

| Property           | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| **Network**        | Base L2                                                              |
| **Solidity**       | 0.8.x                                                                |
| **Pattern**        | Immutable. No upgrade path in MVP; changes ship as audited redeploys |
| **Tenant signing** | EIP-712 `PolicyRegistration`                                         |

### Interface

```solidity
interface IBrainPolicyRegistry {
    event PolicyRegistered(
        bytes32 indexed tenantId,
        uint256 indexed version,
        bytes32 policyHash,
        address[] signers,
        uint256 activatedAt
    );

    function registerPolicy(
        bytes32 tenantId,
        uint256 version,
        bytes32 policyHash,
        address[] calldata signers,      // pre-authorized tenant signers, ascending order
        bytes[]   calldata signatures    // EIP-712 PolicyRegistration, one per signer
    ) external;

    function getPolicy(bytes32 tenantId, uint256 version)
        external view
        returns (bytes32 hash, address[] memory signers, uint256 activatedAt);
}
```

A policy version is registered by one or more EIP-712 signatures from addresses that are already authorized as tenant signers. The registry does not store policy bodies, only the hash, the signer set, and the activation timestamp.

### EIP-712 Type

Tenants sign the canonical hash, not the prose.

```
PolicyRegistration(
  bytes32 tenantId,
  uint256 version,
  bytes32 policyHash
)
```

| Field        | Purpose                                            |
| ------------ | -------------------------------------------------- |
| `tenantId`   | The tenant the policy belongs to                   |
| `version`    | Monotonically increasing version number            |
| `policyHash` | SHA-256 hash of the canonical compiled policy JSON |

### Lifecycle

```
draft → compile → review → sign (EIP-712) → registerPolicy() → active
```

| Phase        | Where                                         |
| ------------ | --------------------------------------------- |
| **Draft**    | Console or API                                |
| **Compile**  | Off-chain Policy compiler                     |
| **Review**   | Tenant reviews compiled JSON plus explanation |
| **Sign**     | Tenant signs `PolicyRegistration`             |
| **Register** | `registerPolicy()` called on Base             |
| **Active**   | Until superseded by a newer version           |

### What Is on-Chain vs Off-Chain

| On-chain            | Off-chain                 |
| ------------------- | ------------------------- |
| `tenantId` (hashed) | Tenant raw identifier     |
| `version`           | Plain-English policy text |
| `policyHash`        | Compiled JSON rules       |
| `activatedAt`       | Compiler explanation      |
| Signer addresses    | Diff between versions     |

{% hint style="info" %}
The policy text is private to the tenant. Only its hash is anchored. A counterparty verifying a policy verdict checks that the verdict references a hash registered on-chain, not the policy text itself.
{% endhint %}

### Policy Lookup

Registered policies are read by explicit version. There is no revocation and no
implicit "active" pointer: a policy is superseded when a higher version is
registered, and the highest registered version per tenant is tracked in the
public `latestVersion` mapping.

```solidity
(bytes32 hash, address[] memory signers, uint256 activatedAt) =
    registry.getPolicy(tenantId, version);

uint256 latest = registry.latestVersion(tenantId);
```

A verifier reads `getPolicy` for the version a verdict references and confirms
the on-chain hash matches the compiled policy it was shown.

### Versioning Rules

| Rule                                          | Detail                                        |
| --------------------------------------------- | --------------------------------------------- |
| `version` must increase                       | A version at or below `latestVersion` reverts |
| Each `(tenantId, version)` is write-once      | Re-registering the same version reverts       |
| Signers must be pre-authorized for the tenant | An unknown signer reverts                     |
| Signers supplied in ascending address order   | Enforces uniqueness across the signer set     |

### Privacy

The on-chain footprint is intentionally minimal. The hash commits to the policy without revealing it.

| Mechanism                                        | Effect                                                    |
| ------------------------------------------------ | --------------------------------------------------------- |
| `tenantId` is hashed before storage              | Cross-tenant correlation is hard                          |
| `policyHash` is SHA-256 of compiled JSON         | The structure is hidden                                   |
| Off-chain logic enforces canonical serialization | Two compilations of the same policy produce the same hash |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Policy and Permissioning</strong></td><td>The conceptual model.</td><td><a href="../protocol/policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>Policy API</strong></td><td>HTTP reference for policy operations.</td><td><a href="../api-reference/policy-api.md">policy-api.md</a></td><td></td></tr><tr><td><strong>BrainSmartAccount</strong></td><td>How policy versions are validated on session-key calls.</td><td><a href="brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr></tbody></table>
