---
description: Pull a verifiable trail of what your agent (or user) did.
---

# Audit Every Action

Goal: pull a complete, tamper-evident record of every meaningful event for a tenant. Useful for compliance review, customer disputes, internal reporting, and proving to auditors that the right thing happened.

### Reading the Trail

```typescript
const events = await brain.audit.list("acme", {
  from:  "2025-09-01",
  to:    "2025-09-30",
  type:  "action.executed",  // optional filter
});

events.data.forEach((e) => {
  console.log(e.timestamp, e.type, e.actor, e.summary);
});
```

| Type                  | When                                  |
| --------------------- | ------------------------------------- |
| `source.connected`    | A source connected for the tenant     |
| `transaction.created` | A new transaction landed              |
| `wiki.query`          | A natural-language question was asked |
| `policy.evaluated`    | A policy decision was rendered        |
| `action.proposed`     | An agent proposed an action           |
| `action.approved`     | A human signed approval               |
| `action.executed`     | An action settled on its rail         |
| `audit.anchored`      | A Merkle root was anchored on Base    |

### Verifying a Specific Action

For any action, you can pull a Merkle proof verifiable on-chain.

```typescript
const proof = await brain.proof(actionId);

proof.event;        // the event itself
proof.merklePath;   // sibling hashes from leaf to root
proof.anchorRoot;   // the Merkle root anchored on Base
proof.anchorTx;     // the transaction that anchored it
proof.anchorBlock;  // the Base block number
```

You can hand this to a counterparty or auditor. They can verify it without trusting Brain.

```solidity
// Public verifier on Base
bool valid = brainAuditAnchor.verify(
  tenantIdHash,
  batchIndex,
  eventLeaf,
  merklePath
);
```

### Pulling the Trace for One Action

Trace IDs link every event tied to one action.

```typescript
const trace = await brain.trace(actionId);

console.log(trace.events);
// [
//   { type: "action.proposed",    timestamp: "..." },
//   { type: "policy.evaluated",   decision: "needs_approval" },
//   { type: "action.approved",    actor: "user_cfo" },
//   { type: "action.executed",    rail: "ach", txHash: null },
//   { type: "action.settled",     receipt: "..." },
//   { type: "audit.anchored",     batchIndex: 4127 }
// ]
```

You can paste a trace ID into the Console to see the same view rendered visually.

### Exporting for Compliance Review

For SOC 2, ISO 27001, or any structured review, export the log as a file.

```typescript
const job = await brain.audit.export("acme", {
  format: "ndjson",  // or "csv"
  from:   "2025-01-01",
  to:     "2025-12-31",
});

// Poll until ready.
let status;
do {
  await new Promise((r) => setTimeout(r, 1000));
  status = await brain.audit.exportStatus(job.id);
} while (status.state !== "ready");

console.log(status.downloadUrl);  // signed URL valid for 24 hours
```

The export contains every event in the range plus the Merkle proofs needed to verify any of them after the fact.

### Streaming Events Live

Subscribe to the audit stream as events happen.

```typescript
const unsubscribe = brain.audit.subscribe("acme", {
  onEvent: (e) => {
    console.log(e.type, e.id, e.timestamp);
    // ship to your SIEM, Datadog, Splunk, whatever
  },
});
```

Or use webhooks if you'd rather not hold an open connection.

### Filtering by Actor

Useful for "what did agent X do today?"

```typescript
const today = await brain.audit.list("acme", {
  actor: "agent:payments-v1",
  from:  new Date(Date.now() - 86400_000).toISOString(),
});
```

Or "what did user Y do?"

```typescript
const trail = await brain.audit.list("acme", {
  actor: "user:user_cfo",
  from:  "2025-01-01",
});
```

### What You Don't Have to Worry About

| Concern               | Why Brain handles it                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| **Tamper resistance** | Every event is hashed and chained; Merkle roots anchor on Base hourly |
| **Per-event signing** | Anchorer keys live in HSMs; rotation is governed                                |
| **Reorg safety**      | Reads wait for finality; cross-batch references catch dropped anchors           |
| **Privacy**           | Only Merkle roots and hashed tenant IDs are on-chain; no payload data leaks     |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🔌 External Agent</strong></td><td>Authorize an MCP-compatible agent and audit its actions the same way.</td><td><a href="let-an-external-agent-in.md">let-an-external-agent-in.md</a></td><td></td></tr><tr><td><strong>📦 Audit and Proof</strong></td><td>How the audit trail works underneath.</td><td><a href="audit-every-action.md">audit-every-action.md</a></td><td></td></tr></tbody></table>
