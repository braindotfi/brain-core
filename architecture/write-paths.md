# Write paths

Brain's six layers form a one-way upward data flow. Information flows up; control flows down. Within that flow, only **two write paths are allowed to write upward into the authoritative state** without coming from below: agent contributions to Raw, and agent-proposed PaymentIntents into Ledger.

This page documents all write paths, where they originate, and what guarantees each one provides.

### The six-layer write surface

```
┌────────────────────────────────────────────────────┐
│  6. AUDIT       append-only                        │ ← every layer writes here
├────────────────────────────────────────────────────┤
│  5. AGENT       proposals, executions              │ ← agents propose
├────────────────────────────────────────────────────┤
│  4. POLICY      decisions                          │ ← policy evaluation writes
├────────────────────────────────────────────────────┤
│  3. WIKI        pages, snapshots, annotations*     │
├────────────────────────────────────────────────────┤
│  2. LEDGER      11 entities                        │
├────────────────────────────────────────────────────┤
│  1. RAW         artifacts, parsed                  │
└────────────────────────────────────────────────────┘
```

(\*) Wiki annotations write through Raw, not directly into Ledger.

### The default rule: information flows upward

Each layer is derived from the layer below it. The Ledger is derived from Raw via deterministic extraction. The Wiki is regenerated from Ledger and Raw on demand. Policy reads from Ledger. Agents read from all of the above and write proposals.

This rule has one purpose: **everything authoritative is replayable**. If an extractor changes, the Ledger can be re-derived from Raw. If a Wiki generator changes, pages can be re-rendered from Ledger and Raw. Source immutability at Raw is what makes the whole protocol auditable.

### The two controlled exceptions

Two write paths break the strict bottom-up rule. They are explicit, scoped, and audited.

#### Exception 1: Agent contributions to Raw

External agents with `raw:write` scope can push artifacts into the Raw layer. Stored, content-addressed, attributed to the agent's on-chain registration.

| Property                           | Value                                               |
| ---------------------------------- | --------------------------------------------------- |
| **Originates from**                | External agent (off-protocol)                       |
| **Writes to**                      | Raw                                                 |
| **Required scope**                 | `raw:write` (on-chain in `BrainMCPAgentRegistry`)   |
| **Signature requirement**          | EIP-712 over content + tenant\_id + timestamp       |
| **Quarantine?**                    | Yes, for the first N contributions from a new agent |
| **Confidence cap on derived rows** | 0.5                                                 |

[**→ Agent Contributions**](../protocol/agent-contributions.md)

#### Exception 2: Agent-proposed PaymentIntents into Ledger

Agents create PaymentIntent rows in the Ledger as proposals for financial actions. PaymentIntents are the only Ledger-write path that does not originate from a Raw extraction.

| Property            | Value                                                    |
| ------------------- | -------------------------------------------------------- |
| **Originates from** | Internal or external agents                              |
| **Writes to**       | Ledger (`ledger_payment_intents`)                        |
| **Required scope**  | `payment_intent:propose` (for external agents)           |
| **Service method**  | `PaymentIntentService.create()` (shared by HTTP and MCP) |
| **Lifecycle gates** | Policy → Approval → 13-step pre-execution gate        |

[**→ Payment Intents**](../protocol/payment-intents.md)

### All write paths, by layer

#### Raw

| Writer           | Path                                             | Notes                                           |
| ---------------- | ------------------------------------------------ | ----------------------------------------------- |
| Source adapters  | Webhook + ingestion endpoints                    | Plaid, NetSuite, Gmail, Alchemy, generic upload |
| Wiki annotations | `POST /v1/wiki/annotate` writes through Raw      | Annotations never write directly into Ledger    |
| External agents  | `raw.contribute` MCP tool with `raw:write` scope | Quarantine, then standard extraction            |
| Tombstoning      | `DELETE /v1/raw/{id}`                            | Writes a tombstone, never mutates the original  |

#### Ledger

| Writer                        | Path                                   | Notes                                   |
| ----------------------------- | -------------------------------------- | --------------------------------------- |
| Extraction pipeline           | Derived from Raw via parsers           | The default and dominant write path     |
| Reconciliation engine         | Writes `ledger_reconciliation_matches` | Triggered by `reconciliation-agent`     |
| Agent-proposed PaymentIntents | `PaymentIntentService.create()`        | The exception                           |
| Re-normalization              | `POST /v1/ledger/normalize`            | Idempotent re-extraction of an artifact |

#### Wiki

| Writer        | Path                                                 | Notes                                 |
| ------------- | ---------------------------------------------------- | ------------------------------------- |
| Page renderer | `wiki_pages` regenerated from Ledger + Raw           | On schedule and on demand             |
| Annotations   | `wiki_annotations` plus a corresponding Raw artifact | Annotations are human-authored memory |
| Snapshots     | `wiki_snapshots` updated when Ledger rows change     | Bitemporal pointers                   |

#### Policy

| Writer          | Path                                                | Notes                                     |
| --------------- | --------------------------------------------------- | ----------------------------------------- |
| Policy compose  | `POST /v1/policy/{tenant}/compose` produces a draft | Stays in `draft` state                    |
| Policy sign     | `POST /v1/policy/{tenant}/sign` activates a version | Plus on-chain registration for enterprise |
| Policy evaluate | Writes a `policy_decisions` row per evaluation      | The audit-trail anchor                    |

#### Agent

| Writer            | Path                                                               | Notes                 |
| ----------------- | ------------------------------------------------------------------ | --------------------- |
| Proposal          | `proposals` row from `agent.action.propose` or internal agent code | Non-financial actions |
| Execution attempt | `executions` row when a Proposal or PaymentIntent is dispatched    | Idempotency-keyed     |
| Approval          | `approvals` row from human signing approval                        | EIP-712               |

#### Audit

| Writer           | Path                                      | Notes                       |
| ---------------- | ----------------------------------------- | --------------------------- |
| Every layer      | `audit_events` append-only writes         | Every material state change |
| Anchor publisher | `audit_anchors` per published Merkle root | Hourly cadence       |

### What is not allowed

| Forbidden                                                                        | Why                                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Direct Ledger write that does not originate from Raw extraction or PaymentIntent | Breaks replayability                                            |
| Wiki text used as a source of truth for balances, transactions, obligations      | Wiki is human-readable memory; Ledger is machine-readable truth |
| Policy reading Wiki for evaluation                                               | Policy reads Ledger only; Wiki is for narrative                 |
| Audit row UPDATE or DELETE                                                       | Audit is append-only; no exceptions                             |
| Anchor re-publication of the same Merkle root                                    | Idempotency at the on-chain layer                               |

### Implications

| Property               | Consequence                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| **Replayability**      | Drop the Ledger and Wiki; rebuild deterministically from Raw plus extraction logic       |
| **Auditability**       | Every row carries provenance back to `raw_artifacts.id` plus `raw_parsed.id`             |
| **Tenant trust**       | Agent contributions are quarantined and capped at 0.5 confidence until reviewed          |
| **Counterparty trust** | Anyone with a Merkle proof can verify against the on-chain anchor without trusting Brain |

### What's next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🏗️ System overview</strong></td><td>The full architecture top-down.</td><td><a href="system-overview.md">system-overview.md</a></td><td></td></tr><tr><td><strong>🌊 Data flow</strong></td><td>How a single source-of-truth event ripples up.</td><td><a href="data-flow.md">data-flow.md</a></td><td></td></tr><tr><td><strong>🛡️ Tenant isolation</strong></td><td>How tenants are separated at every layer.</td><td><a href="tenant-isolation.md">tenant-isolation.md</a></td><td></td></tr></tbody></table>
