# BrainAuditAnchor

`BrainAuditAnchor` stores Merkle roots of per-tenant audit batches. Anchors are immutable after submission.

<table><thead><tr><th width="200">Property</th><th>Value</th></tr></thead><tbody><tr><td><strong>Network</strong></td><td>Base L2</td></tr><tr><td><strong>Solidity</strong></td><td>0.8.x</td></tr><tr><td><strong>Pattern</strong></td><td>Transparent proxy with 48-hour upgrade timelock</td></tr><tr><td><strong>Anchorer keys</strong></td><td>HSM-protected, rotated on a fixed schedule</td></tr></tbody></table>

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

<table><thead><tr><th width="100">Step</th><th>Detail</th></tr></thead><tbody><tr><td>1</td><td>Audit events batch into a Merkle tree per tenant</td></tr><tr><td>2</td><td>Anchorer service signs the root with its HSM-backed key</td></tr><tr><td>3</td><td>The signed root is submitted via <code>anchorRoot()</code></td></tr><tr><td>4</td><td>Contract emits <code>RootAnchored</code>; the root becomes immutably retrievable</td></tr></tbody></table>

### Strict Monotonicity

The contract enforces that `batchIndex` per tenant increases monotonically.

<table><thead><tr><th width="250">Behavior</th><th>Detail</th></tr></thead><tbody><tr><td><strong>First batch for a tenant</strong></td><td><code>batchIndex = 0</code></td></tr><tr><td><strong>Subsequent batches</strong></td><td>Must equal previous + 1</td></tr><tr><td><strong>Out-of-order submission</strong></td><td>Reverts</td></tr></tbody></table>

This prevents anchorer compromise from rewriting history by inserting older batches with conflicting roots.

### Verification by Counterparties

A counterparty does not need a Brain account to verify an audit event. They just need:

<table><thead><tr><th width="250">Input</th><th>Source</th></tr></thead><tbody><tr><td><code>tenantId</code></td><td>Hashed identifier from the proof</td></tr><tr><td><code>batchIndex</code></td><td>From the proof</td></tr><tr><td><code>leaf</code></td><td>Hash of the event being verified</td></tr><tr><td><code>proof[]</code></td><td>Merkle path supplied by Brain</td></tr></tbody></table>

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

Only Merkle roots and hashed `tenantId` values are on-chain. Everything underneath stays off-chain and encrypted in S3 with tenant-scoped DEKs.

<table><thead><tr><th width="250">On-chain</th><th>Off-chain</th></tr></thead><tbody><tr><td><code>tenantId</code> (hashed)</td><td>Tenant raw identifier</td></tr><tr><td><code>root</code> (Merkle root)</td><td>Individual audit events</td></tr><tr><td><code>batchIndex</code>, <code>timestamp</code></td><td>Event content, citations, decisions</td></tr></tbody></table>
