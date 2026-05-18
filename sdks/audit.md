# Audit

The `brain.audit` namespace gives you query and proof access to the per-tenant hash chain. Every event has a Merkle proof that anchors to `BrainAuditAnchor` on Base L2.

### Get an Audit Event

```typescript
const event = await brain.audit.get(eventId);

event.event_type;        // "policy.evaluated", "action.executed", etc
event.tenant_id;
event.actor;             // user ID or agent address
event.timestamp;
event.inputs_hash;
event.policy_version;
event.decision;
event.reason;
event.prev_event_hash;
event.batch_index;       // Which Merkle batch contains this event
```

### Pull a Merkle Proof

```typescript
const proof = await brain.audit.proof(eventId);

proof.event;             // The event itself
proof.merkle_path;       // bytes32[]
proof.anchored_root;     // bytes32
proof.base_tx_hash;      // tx where the root was anchored
proof.base_block;        // block number of the anchor
proof.batch_index;       // batch index in BrainAuditAnchor
```

### Verify a Proof Off-Chain

The SDK includes a verifier helper. **No Brain account required to verify.**

```typescript
import { verifyMerkleProof } from "@brain/sdk";

const ok = verifyMerkleProof({
  leaf:    hashEvent(proof.event),
  path:    proof.merkle_path,
  root:    proof.anchored_root,
});

console.log(ok); // true if the proof is valid
```

### Verify a Proof on-Chain

A counterparty smart contract can verify by calling `BrainAuditAnchor.verify` directly.

```solidity
IBrainAuditAnchor anchor = IBrainAuditAnchor(ANCHOR_ADDRESS);

bool ok = anchor.verify(
    tenantId,
    batchIndex,
    leaf,
    merkleProof
);

require(ok, "Audit proof invalid");
```

**→ BrainAuditAnchor reference**

### List Events for a Tenant

```typescript
const events = await brain.audit.list({
  tenantId: "acme",
  from: "2025-01-01",
  to:   "2025-12-31",
  eventType: "action.executed",
  limit: 100,
});
```

### Stream New Events

```typescript
const unsubscribe = brain.audit.subscribe("acme", {
  onEvent: (e) => console.log(e.event_type, e.id),
});
```

### Walk the Chain

The hash chain links every event to its predecessor. You can walk backwards from any event.

```typescript
async function walkBack(eventId: string, depth: number) {
  const events = [];
  let current = await brain.audit.get(eventId);

  for (let i = 0; i < depth && current.prev_event_hash; i++) {
    events.push(current);
    const prev = await brain.audit.getByHash(current.prev_event_hash);
    current = prev;
  }

  return events;
}
```

### Compliance Exports

Pre-formatted exports for common compliance reviews.

```typescript
const soc2Export = await brain.audit.export({
  tenantId: "acme",
  format: "soc2",
  from: "2025-01-01",
  to:   "2025-12-31",
});

// soc2Export.url is a signed S3 URL valid for 24 hours
```

| Format               | Coverage                                        |
| -------------------- | ----------------------------------------------- |
| `soc2`               | SOC 2 Type II evidence package                  |
| `iso27001`           | ISO 27001 evidence package                      |
| `financial_controls` | Approval chains, segregation-of-duties evidence |
| `raw_jsonl`          | Full event log as JSON Lines                    |

### Public Verifier

For sharing proofs with parties who do not have a Brain account, the public verifier endpoint takes a proof bundle and returns a verification result.

```typescript
// Tenant: share a proof bundle
const bundle = await brain.audit.exportProof(eventId);
console.log(bundle.shareUrl);
// e.g. https://verify.brain.fi/p/abc123

// Counterparty: open the URL or call the API directly
// No Brain credentials needed.
```

{% hint style="success" %}
Audit compounds across counterparties. As more counterparties accept Brain audit proofs, every party in the graph benefits from cheaper, faster verification.
{% endhint %}
