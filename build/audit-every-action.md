---
description: Read a tenant-scoped, tamper-evident audit trail and verify its inclusion proofs.
---

# Audit Every Action

Goal: retrieve the authenticated tenant's meaningful audit events for compliance
review, support work, and proof verification.

The API and off-chain audit service are production available. The public anchor
contract runs on Base Sepolia only and is unaudited.

### Read the Trail

```typescript
const page = await brain.audit.list({
  layer: "execution",
  since: "2025-09-01T00:00:00.000Z",
  until: "2025-09-30T23:59:59.999Z",
  limit: 100,
});

for (const event of page.events) {
  console.log(event.id, event.action, event.created_at);
}
console.log(page.nextCursor);
```

The available filters are `layer`, `actor`, `since`, `until`, `limit`, and
`cursor`.

| Event action | Meaning |
| --- | --- |
| `wiki.question` | A Wiki question was processed |
| `policy.evaluate` | A policy evaluation was recorded |
| `ledger.transaction.created` | A Ledger transaction was created |
| `agent.action.proposed` | An agent created a proposal |
| `payment_intent.approved` | A human approval completed |
| `payment_intent.executed` | A payment completed |

### Verify a Payment Proof

```typescript
const proof = await brain.proof("pi_8231");

console.log(proof.merkle_root);
console.log(proof.merkle_proof);
console.log(proof.chain_anchor?.tx_hash);
console.log(proof.chain_anchor?.block_number);
console.log(proof.rail_receipt);
```

The proof includes the exact `audit_events` objects used for the proof, rather
than only event identifiers.

### Trace an Entity

```typescript
const trace = await brain.trace("pi_8231");

for (const entry of trace.entries) {
  console.log(entry.event.action, entry.event.created_at);
  console.log(entry.inclusionProof.merkleRoot);
}
```

`brain.trace` is an SDK aggregation over the entity history and each event's
inclusion proof. Its entries are `{ event, inclusionProof }`.

### Export Tenant Data

`brain.audit.export()` is an intentional SDK stub and the underlying audit
export endpoint returns 501. Use the tenant export lifecycle instead:

```text
POST /v1/tenants/{tenant_id}/export
GET  /v1/tenants/{tenant_id}/export/{job_id}
GET  /v1/tenants/{tenant_id}/export/{job_id}/download
```

### Filter by Actor

```typescript
const page = await brain.audit.list({
  actor: "agent:payments-v1",
  since: new Date(Date.now() - 86_400_000).toISOString(),
  limit: 100,
});

for (const event of page.events) {
  console.log(event.action, event.created_at);
}
```

### What's Next

- [Let an External Agent In](let-an-external-agent-in.md)
- [Audit and Proof](../protocol/audit-and-proof.md)
