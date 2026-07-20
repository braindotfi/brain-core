# BrainAuditAnchor

`BrainAuditAnchor` stores Merkle roots of per-tenant audit batches. Anchors are immutable after submission.

| Property          | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| **Network**       | Base Sepolia today                                                   |
| **Solidity**      | 0.8.x                                                                |
| **Pattern**       | Immutable. No upgrade path in MVP; changes ship as audited redeploys |
| **Anchorer keys** | Current testnet publisher is a single EOA; HSM is pre-mainnet TODO   |

### Interface

```solidity
interface IBrainAuditAnchor {
    event AnchorPublished(
        bytes32 indexed tenantId,
        bytes32 root,
        uint256 eventCount,
        uint256 periodStart,
        uint256 periodEnd
    );

    function anchor(
        bytes32 tenantId,
        bytes32 root,
        uint256 eventCount,
        uint256 periodStart,
        uint256 periodEnd
    ) external;  // onlyPublisher

    function latestAnchor(bytes32 tenantId)
        external view returns (bytes32 root, uint256 blockNumber);

    function latestAnchorFull(bytes32 tenantId)
        external view
        returns (bytes32 root, uint256 blockNumber, uint256 eventCount, uint256 periodEnd);

    function verifyInclusion(
        bytes32 root,
        bytes32 leaf,
        bytes32[] calldata proof
    ) external pure returns (bool);

    function isPublished(bytes32 tenantId, bytes32 root)
        external view returns (bool);
}
```

Publication is authorized by the caller, not by a per-call signature. The `anchor` function is `onlyPublisher`; in production the publisher is a Safe multi-sig (2-of-3), so a single-key compromise cannot publish.

### How Anchoring Works

```
Off-chain audit log
   │
   ├─ events batched per tenant over a period window
   │
   ├─ Merkle tree built per batch
   │
   └─ publisher (multi-sig) calls anchor() on Base L2
```

| Step | Detail                                                                       |
| ---- | ---------------------------------------------------------------------------- |
| 1    | Audit events batch into a Merkle tree per tenant over a period window        |
| 2    | The publisher multi-sig submits the root, event count, and period bounds     |
| 3    | The root is published via `anchor()`                                         |
| 4    | Contract emits `AnchorPublished`; the root becomes immutably retrievable      |

### Replay Protection

The contract records every published `(tenantId, root)` pair and rejects a repeat.

| Behavior                             | Detail                                       |
| ------------------------------------ | -------------------------------------------- |
| **First time a root is published**   | Stored as the tenant's latest anchor         |
| **Re-publishing the same root**      | Reverts with `RootAlreadyPublished`          |
| **Period bounds**                    | `periodEnd` before `periodStart` reverts     |

Root-uniqueness per tenant is the replay guard: a published root cannot be re-anchored for the same tenant. There is no batch-index sequence to maintain, so anchoring never depends on submission order.

### Verification by Counterparties

A counterparty does not need a Brain account to verify an audit event. They just need:

| Input     | Source                                          |
| --------- | ----------------------------------------------- |
| `root`    | The published Merkle root (read via `latestAnchor` or event logs) |
| `leaf`    | Hash of the event being verified                |
| `proof[]` | Merkle path supplied by Brain                   |

```solidity
bool valid = anchor.verifyInclusion(root, leaf, proof);
```

If `valid` is true, the event is provably part of the anchored history under that root. `verifyInclusion` uses domain-separated hashing: leaf nodes are `keccak256(0x00 ++ leaf)` and internal nodes are `keccak256(0x01 ++ sort(left, right))`.

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

### Publisher Rotation

The publisher is rotated through a two-step handoff so a mistyped or uncontrolled address can never brick anchoring. The current publisher proposes the next address with `setPublisher(next)` (publisher-only), and the rotation takes effect only when that address calls `acceptPublisher()`. The contract itself is immutable, so there is no upgrade path. Only the publisher address changes.

```solidity
event PublisherTransferStarted(address indexed currentPublisher, address indexed pendingPublisher);
event PublisherChanged(address indexed oldPublisher, address indexed newPublisher);

function setPublisher(address next) external;  // onlyPublisher, proposes the handoff
function acceptPublisher() external;           // called by the pending publisher to complete it
```

### Privacy

Only Merkle roots and hashed `tenantId` values are on-chain. Everything underneath stays off-chain in tenant-prefixed storage and tenant-scoped database rows. Source credentials use the global AES-256-GCM credential key described in `shared/src/crypto/credential-key-provider.ts`.

| On-chain                          | Off-chain                           |
| --------------------------------- | ----------------------------------- |
| `tenantId` (hashed)               | Tenant raw identifier               |
| `root` (Merkle root)              | Individual audit events             |
| `eventCount`, `periodStart`, `periodEnd` | Event content, citations, decisions |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Audit and Proof</strong></td><td>The conceptual model.</td><td><a href="../protocol/audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr><tr><td><strong>Audit API</strong></td><td>Retrieve events and proofs over HTTP.</td><td><a href="../api-reference/audit-api.md">audit-api.md</a></td><td></td></tr></tbody></table>
