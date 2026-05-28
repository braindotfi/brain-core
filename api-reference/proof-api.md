# Proof API

The Proof API returns the canonical, single-artifact record of how a financial action was decided, gated, executed, and anchored. It's the flagship trust artifact: one fetch, every dimension. Policy decision, §6 gate trace, evidence chain, audit Merkle proof, on-chain anchor, rail receipt, plain-English explanation.

| Operation                   | Endpoint                         | Scope        |
| --------------------------- | -------------------------------- | ------------ |
| Canonical Proof (JSON)      | `GET /v1/proof/{action_id}`      | `audit:read` |
| Human-readable Proof (HTML) | `GET /v1/proof/{action_id}/view` | `audit:read` |

`action_id` is the PaymentIntent id. Both routes are **tenant-isolated**: a cross-tenant id returns `404`. The existence of the action is never leaked across tenants.

### Get a Proof

```http
GET /v1/proof/{action_id}
Authorization: Bearer <token>
```

```json
{
  "action_id": "pi_a1b2c3",
  "tenant_id": "acme",
  "agent_id": "ag_payment_v1",
  "behavior_hash": "0x...",
  "outcome": "executed",
  "policy_version": 4,
  "policy_hash": "0xabc...",
  "matched_rule_id": "rule_invoice_above_5k",
  "gate_checks": [
    { "index": 1, "name": "intent_exists_and_approved", "passed": true },
    { "index": 1.5, "name": "agent_behavior_pinned", "passed": true },
    { "index": 5, "name": "source_balance_sufficient", "passed": true },
    { "index": 7, "name": "counterparty_not_sanctioned", "passed": true },
    { "index": 13, "name": "audit_chain_healthy", "passed": true }
  ],
  "evidence": [{ "raw_id": "raw_8231", "parser": "invoice_v2", "confidence": 0.98 }],
  "ledger_snapshot_hash": "0x...",
  "audit_events": ["audit_evt_001", "audit_evt_002"],
  "merkle_root": "0xabc...",
  "merkle_proof": ["0x111...", "0x222..."],
  "chain_anchor": { "tx_hash": "0xdef...", "block": 8829110 },
  "rail_receipt": { "rail": "bank_ach", "provider_id": "..." },
  "human_explanation": "Paid invoice inv_8231 for $7,800.00 to Amazon Web Services on Mercury operating account..."
}
```

### Fields

| Field                            | Description                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `outcome`                        | `allowed` \| `confirmed` \| `rejected` \| `executed` \| `failed` \| `shadow_completed`             |
| `behavior_hash`                  | The agent's runtime `behaviorHash`. Must equal the value registered on-chain (§6 check 1.5)       |
| `policy_version` / `policy_hash` | The policy version evaluated and its content hash                                                  |
| `matched_rule_id`                | The DSL rule that fired                                                                            |
| `gate_checks[]`                  | Every numbered + hardening check, in execution order, with `passed: boolean` and optional `reason` |
| `evidence[]`                     | The Raw-parsed rows the agent and the gate consulted                                               |
| `ledger_snapshot_hash`           | Hash of the Ledger state Policy decided against (the snapshot the §6 7.5 check re-validates)       |
| `audit_events[]`                 | Every audit event id covering this action                                                          |
| `merkle_root` / `merkle_proof`   | The Merkle inclusion proof for the audit-chain leaves                                              |
| `chain_anchor`                   | The on-chain anchor for the containing batch. `null` until the batch lands on Base                |
| `rail_receipt`                   | The typed rail receipt (`ach` / `wire` / `erp` / `onchain` schemas)                                |
| `human_explanation`              | One-paragraph plain-English summary, deterministically generated                                   |

### Verifying a Proof

Three independent paths to the same conclusion:

| Method                       | Description                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| **SDK helper**               | `verifyMerkleProof(...)` from `@brain/sdk`. No Brain account required                        |
| **On-chain call**            | `BrainAuditAnchor.verify(tenantId, batchIndex, leaf, merkleProof)` from any Solidity contract |
| **Public verifier endpoint** | `POST /v1/audit/verify`. Supply event hash, Merkle proof, and claimed root                   |

### Human-Readable View

For compliance, investor, or counterparty screens. The same Proof rendered as a single HTML page:

```http
GET /v1/proof/{action_id}/view
Authorization: Bearer <token>
```

Returns `text/html` with the same data laid out for human reading. Same tenant-isolation and `audit:read` scope.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📜 Audit API</strong></td><td>Underlying events, anchors, exports.</td><td><a href="audit-api.md">audit-api.md</a></td><td></td></tr><tr><td><strong>🚪 The Pre-Execution Gate</strong></td><td>What the gate-check rows mean.</td><td><a href="../protocol/the-pre-execution-gate.md">the-pre-execution-gate.md</a></td><td></td></tr><tr><td><strong>📜 Audit and Proof</strong></td><td>The conceptual model.</td><td><a href="../protocol/audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr></tbody></table>
