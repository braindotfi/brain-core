# Audit and proof

Every event in Brain (ingestion, extraction, query, proposal, policy decision, approval, execution, settlement) emits an audit record into an append-only log. Records form a per-tenant **Merkle tree**. Tree roots are batched and anchored on-chain through `BrainAuditAnchor`.

### Three properties this gives you

<table data-view="cards"><thead><tr><th></th><th></th></tr></thead><tbody><tr><td><strong>📜 Tenant-verifiable history</strong></td><td>A tenant can prove a specific decision occurred at a specific time, based on specific evidence, under a specific policy version.</td></tr><tr><td><strong>🤝 Counterparty-verifiable proofs</strong></td><td>A counterparty can verify a payment was authorized without seeing the underlying data, by checking a Merkle proof against an anchored root.</td></tr><tr><td><strong>🔒 No silent rewrites</strong></td><td>Brain itself cannot silently rewrite history. Anchors commit the past state to a public chain.</td></tr></tbody></table>

### What every audit event commits to

Audit events are content-addressed. Each event commits to:

| Field             | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `event_type`      | `proposal`, `policy.evaluated`, `action.executed`, etc |
| `tenant_id`       | Which tenant generated the event                       |
| `actor`           | Human user ID or agent address                         |
| `timestamp`       | When the event was recorded                            |
| `inputs_hash`     | Hash of Ledger / Wiki / Raw IDs the event depended on  |
| `policy_version`  | The policy version evaluated, if any                   |
| `decision`        | The outcome of the event (where applicable)            |
| `reason`          | Structured reason code (where applicable)              |
| `prev_event_hash` | Forms a per-tenant hash chain                          |

The `prev_event_hash` field means each event references the one before it, building a chain that breaks if anything is altered.

### The hash chain in pictures

```
event_001     event_002     event_003     event_004
  hash=A   ←   hash=B   ←   hash=C   ←   hash=D
                prev=A        prev=B        prev=C
```

Tamper with `event_002` and `B` changes. `event_003` still references the old `B` via its `prev=B` pointer. The chain breaks. Detection is automatic.

### Merkle batching and on-chain anchoring

Events are batched into a per-tenant Merkle tree. Roots are anchored to Base L2 through `BrainAuditAnchor`.

| Property                | Value                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Anchor cadence**      | Every 10 minutes (default)                                                                                 |
| **Immediate anchoring** | On high-severity events (large transfers, new counterparties, policy changes)                              |
| **Anchor target**       | `BrainAuditAnchor` on Base L2                                                                              |
| **Anchor authority**    | Brain anchorer key, EIP-712 signed                                                                         |
| **Reorg tolerance**     | Anchors reference previous batch; small reorg windows tolerated; off-chain log is canonical until anchored |

[**→ BrainAuditAnchor smart contract**](../smart-contracts/brainauditanchor.md)

### Pulling a proof

Counterparties verify Brain audit proofs by checking a Merkle proof against the on-chain anchored root.

```http
GET /v1/audit/{event_id}/proof

→ {
    "event":         { ... },
    "merkle_path":   ["0xabc...", "0xdef...", "..."],
    "anchored_root": "0x...",
    "base_tx_hash":  "0x...",
    "base_block":    8829110
  }
```

To verify, the counterparty:

1. Reads `anchored_root` from `BrainAuditAnchor.rootAt(tenantId, batchIndex)` on Base
2. Reconstructs the leaf hash from the `event` data
3. Walks `merkle_path` to compute the candidate root
4. Compares against `anchored_root`

If they match, the event is provably part of the anchored history. **Brain is not a trusted intermediary in this verification. It is just a publisher.**

### Privacy

On-chain anchors must not leak tenant data.

| What's On-Chain    | What's Off-Chain                   |
| ------------------ | ---------------------------------- |
| Merkle roots       | Event payloads (encrypted at rest) |
| Hashed `tenantId`  | Raw artifacts                      |
| Anchor timestamp   | Ledger records, Wiki entities      |
| Anchorer signature | Policy text and compiled rules     |

Counterparties verifying a proof receive only the specific event(s) the tenant chooses to share, plus the Merkle path. Everything else stays private.

### Compliance exports

The Audit Layer also exposes structured exports for compliance reviews.

| Standard               | Coverage                                           |
| ---------------------- | -------------------------------------------------- |
| **SOC 2 Type II**      | Full event log with provenance                     |
| **ISO 27001**          | Access logs, key management events, change records |
| **Financial controls** | Approval chains, segregation of duties evidence    |

A public verifier endpoint is also available for counterparties to verify proofs without a Brain account.

{% hint style="success" %}
**Audit compounds across counterparties.** As more counterparties accept Brain audit proofs, every party in the graph benefits from cheaper, faster verification.
{% endhint %}

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📐 Policy</strong></td><td>How decisions feed the audit trail.</td><td><a href="policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>📜 BrainAuditAnchor</strong></td><td>The on-chain anchor contract.</td><td><a href="../smart-contracts/brainauditanchor.md">brainauditanchor.md</a></td><td></td></tr><tr><td><strong>🌐 Audit API</strong></td><td>Pull proofs programmatically.</td><td><a href="../api-reference/audit-api.md">audit-api.md</a></td><td></td></tr></tbody></table>
