---
description: Why every claim Brain makes is verifiable.
---

# Proof

Every meaningful event Brain records is hashed, chained, and periodically anchored on Base L2. A counterparty, auditor, or end user can verify that a specific event happened, at a specific time, with a specific decision, **without trusting Brain**.

### Two layers of proof

| Layer              | What it proves                                                                        |
| ------------------ | ------------------------------------------------------------------------------------- |
| **Citations**      | The data behind any answer or decision (transactions, invoices, evidence)             |
| **Merkle anchors** | That the event itself happened, in the order Brain says, with the metadata Brain says |

Citations make claims traceable inside Brain. Anchors make Brain's claims independently verifiable outside Brain.

### What gets logged

Every material state change emits an audit event:

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

Read endpoints (Wiki queries, Ledger reads) also land in the log. Anyone reviewing the trail can see exactly what was read, by whom, when.

### Tamper-evidence

Each event is hashed deterministically. Each event references the previous event's hash. The result is a per-tenant hash chain.

```
event_n.prev_hash = hash(event_{n-1})
```

To rewrite history, you'd have to regenerate every subsequent hash. And you'd still have to fool the Merkle anchor on Base.

### On-chain anchors

Brain batches audit events into a Merkle tree per tenant and anchors the root on Base every 10 minutes (or sooner for high-severity events). Once anchored, the root is immutable.

```typescript
const proof = await brain.proof(actionId);

proof.merklePath;   // sibling hashes from leaf to root
proof.anchorRoot;   // the Merkle root anchored on Base
proof.anchorTx;     // the transaction that anchored it
```

A counterparty verifies on-chain by calling `BrainAuditAnchor.verify()` with the proof. They don't need a Brain account, an API key, or any access to the underlying data.

### What's on-chain vs off-chain

| On-chain                     | Off-chain                           |
| ---------------------------- | ----------------------------------- |
| Hashed `tenant_id`           | Tenant's actual id                  |
| Merkle roots                 | Individual events                   |
| Batch indexes and timestamps | Event content, citations, decisions |
| Anchor publisher signatures  | Audit event signatures              |

The on-chain footprint is intentionally minimal. The hash commits to history without revealing anything.

### Privacy properties

| Concern                             | How Brain handles                                                     |
| ----------------------------------- | --------------------------------------------------------------------- |
| Counterparty learns tenant identity | Tenant ID is hashed before storage                                    |
| Counterparty learns event content   | Events are off-chain; only hashes anchor                              |
| Anchor publisher compromise         | `batchIndex` is strictly monotonic; out-of-order submissions revert   |
| Reorg drops an anchor               | Reads wait for finality; cross-batch references catch dropped anchors |

### Why "anchored on-chain" matters

Most audit logs in fintech are SOC 2 documents and SQL exports. They prove that the vendor cared. They don't prove that the events happened as described.

An on-chain anchor is the difference between **trust** and **verify**. Even if Brain disappeared tomorrow, the on-chain record would still be queryable on Base, and any party with a Merkle proof could prove what happened.

### Where this lives in the protocol

The proof story is the Audit layer (Layer 6) plus three smart contracts:

| Contract              | Job                                                   |
| --------------------- | ----------------------------------------------------- |
| `BrainAuditAnchor`    | Anchors Merkle roots per tenant                       |
| `BrainPolicyRegistry` | Anchors policy version hashes per tenant              |
| `BrainSmartAccount`   | Validates UserOps against the active policy and scope |

[**→ Smart contracts overview**](../smart-contracts/overview.md)

### Related

| Concept                             | Page                      |
| ----------------------------------- | ------------------------- |
| The data that backs every answer    | Memory                    |
| The decisions captured in the trail | Policy                    |
| Who acts and gets logged            | Agents                    |
| Deep dive                           | Protocol: Audit and Proof |
