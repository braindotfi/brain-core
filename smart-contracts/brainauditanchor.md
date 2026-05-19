# BrainAuditAnchor

`BrainAuditAnchor` stores Merkle roots of per-tenant audit batches. Anchors are immutable after submission.

| Property          | Value                                           |
| ----------------- | ----------------------------------------------- |
| **Network**       | Base L2                                         |
| **Solidity**      | 0.8.x                                           |
| **Pattern**       | Transparent proxy with 48-hour upgrade timelock |
| **Anchorer keys** | HSM-protected, rotated on a fixed schedule      |

### Interface

```solidity
interface IBrainAuditAnchor {
    event RootAnchored(
        bytes32 indexed tenantId,
        bytes32 indexed root,
        uint64  batchIndex,
        uint64  timestamp
    );

    function anchorRoot(
        bytes32 tenantId,
        bytes32 root,
        uint64  batchIndex,
        bytes   calldata anchorerSig  // EIP-712 by Brain anchorer key
    ) external;

    function rootAt(bytes32 tenantId, uint64 batchIndex)
        external view returns (bytes32 root, uint64 timestamp);

    function verify(
        bytes32 tenantId,
        uint64  batchIndex,
        bytes32 leaf,
        bytes32[] calldata proof
    ) external view returns (bool);
}
```

### How Anchoring Works

```
Off-chain audit log
   │
   ├─ events batched per tenant
   │
   ├─ Merkle tree built per batch
   │
   ├─ Anchorer key signs (EIP-712) over (tenantId, root, batchIndex)
   │
   └─ anchorRoot() called on Base L2
```

| Step | Detail                                                                |
| ---- | --------------------------------------------------------------------- |
| 1    | Audit events batch into a Merkle tree per tenant                      |
| 2    | Anchorer service signs the root with its HSM-backed key               |
| 3    | The signed root is submitted via `anchorRoot()`                       |
| 4    | Contract emits `RootAnchored`; the root becomes immutably retrievable |

### Strict Monotonicity

The contract enforces that `batchIndex` per tenant increases monotonically.

| Behavior                     | Detail                  |
| ---------------------------- | ----------------------- |
| **First batch for a tenant** | `batchIndex = 0`        |
| **Subsequent batches**       | Must equal previous + 1 |
| **Out-of-order submission**  | Reverts                 |

This prevents anchorer compromise from rewriting history by inserting older batches with conflicting roots.

### Verification by Counterparties

A counterparty does not need a Brain account to verify an audit event. They just need:

| Input        | Source                           |
| ------------ | -------------------------------- |
| `tenantId`   | Hashed identifier from the proof |
| `batchIndex` | From the proof                   |
| `leaf`       | Hash of the event being verified |
| `proof[]`    | Merkle path supplied by Brain    |

```solidity
bool valid = anchor.verify(tenantId, batchIndex, leaf, proof);
```

If `valid` is true, the event is provably part of the anchored history at that batch.

{% hint style="success" %}
The verifier does not need to trust Brain. They only need to call a public view function on Base L2.
{% endhint %}

### Reorg Tolerance

Base L2 has fast finality, but small reorgs are possible.

| Mitigation                                 | Detail                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| **Confirmation depth**                     | Reads wait for a configurable depth before treating an anchor as final     |
| **Cross-batch references**                 | Each new batch's auxiliary metadata references the previous batch hash     |
| **Off-chain log canonical until anchored** | If a reorg drops an anchor, the off-chain log replays it in the next batch |

### Anchorer Key Rotation

Anchorer keys are rotated on a fixed schedule. The contract maintains a small set of authorized signers. Rotation is governed by the same 48-hour timelock that governs upgrades.

```solidity
event AnchorerAdded(address indexed signer);
event AnchorerRemoved(address indexed signer);
```

### Privacy

Only Merkle roots and hashed `tenantId` values are on-chain. Everything underneath stays off-chain and encrypted in Azure Blob with tenant-scoped DEKs.

| On-chain                  | Off-chain                           |
| ------------------------- | ----------------------------------- |
| `tenantId` (hashed)       | Tenant raw identifier               |
| `root` (Merkle root)      | Individual audit events             |
| `batchIndex`, `timestamp` | Event content, citations, decisions |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛡️ Audit and proof</strong></td><td>The conceptual model.</td><td><a href="../protocol/audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr><tr><td><strong>🌐 Audit API</strong></td><td>Retrieve events and proofs over HTTP.</td><td><a href="../api-reference/audit-api.md">audit-api.md</a></td><td></td></tr></tbody></table>
