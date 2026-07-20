# Data Flow

End-to-end: from a webhook landing in the Raw Layer to an action executing on a rail and proof anchoring on Base.

### The Full Flow

```
Source → Raw → Ledger → Wiki → Policy → Agent → Rail → Audit
```

| Step | What Happens                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | A webhook or scheduled pull lands in **Raw**                                                                            |
| 2    | Extractors normalise it into **Ledger** records                                                                         |
| 3    | **Wiki** updates incrementally (entity resolution, narrative summarisation, embedding refresh)                          |
| 4    | An agent proposes an action referencing **Ledger** context                                                              |
| 5    | **Policy** evaluates the proposal: allow, confirm, or reject                                                            |
| 6    | If approved, the **Agent** Layer executes through an external rail (bank API, payment processor, smart account on Base) |
| 7    | Every step writes an **Audit** event with cryptographic links back to preceding ones                                    |

### Step-by-Step Trace

Imagine a payments agent paying an invoice. Here is what every layer does.

#### Step 1: Raw Lands

```
External event:
  Plaid webhook arrives with new bank transactions.

Brain action:
  - Verify webhook signature.
  - Hash payload (SHA-256).
  - Store in Azure Blob at a tenant-prefixed, content-addressed path.
  - Emit audit event: source.received
```

#### Step 2: Ledger Structures

```
Extractor input:
  Raw artifact (Plaid transaction list).

Extractor output:
  N Ledger records (transactions), each carrying:
    raw_refs:            [sha256:abc...]
    extractor_version:   plaid-v2.1
    confidence:          0.97

Brain action:
  - Apply deterministic extractor.
  - Reconcile against existing records (deduplication).
  - Emit audit event: ledger.appended
```

#### Step 3: Wiki Updates

```
Wiki input:
  New Ledger records.

Wiki action:
  - Entity resolution: is this counterparty already known?
  - Update relationships in the graph.
  - Re-summarise affected narratives.
  - Refresh embeddings for any changed text.
  - Recompute rolling summaries if a period boundary was crossed.
  - Emit audit event: wiki.updated
```

#### Step 4: Agent Proposes

```
Agent input:
  Invoice ID, tenant context, Wiki citations.

Agent output:
  Proposal: { type: "pay_invoice", invoice_id: "inv_8231",
              amount: 7800, counterparty_id: "cp_x" }

Brain action:
  - Record proposal as audit event.
  - Forward to Policy Engine.
```

#### Step 5: Policy Evaluates

```
Policy input:
  Proposal + active policy version (v3) + Ledger state.

Policy evaluation:
  - Counterparty status: approved
  - Amount: $7,800 (above $5,000 threshold)
  - Outcome: confirm, approvers=[role:cfo]

Brain action:
  - Persist the policy decision and trace.
  - Notify required approvers.
  - Emit audit event: policy.evaluated
```

#### Step 6: Approval

```
Approver input:
  Proposal with Ledger references (invoice, PO,
  vendor history, prior payments).

Approver action:
  Approves through an authenticated member session or linked approval surface.

Brain action:
  - Record the member approval in the database.
  - Move action to executable.
  - Emit audit event: action.approved
```

#### Step 7: Execution

Two paths, depending on the rail:

**Off-chain rail**

```
Brain action:
  - Construct bank API request server-side.
  - Use tenant's stored bank credentials.
  - Submit transfer.
  - Capture rail receipt.
  - Emit audit event: action.executed
```

**On-chain via smart account**

```
Brain action:
  - Build the call: BrainSmartAccount.executeViaSessionKey(nonce, target, value, data)
      target:    recipient (e.g. USDC transfer)
      signed by: the granted session key (KMS-held)
  - On-chain executeViaSessionKey enforces:
      ✓ session key granted, not paused or revoked
      ✓ within the key's spend caps (per-tx, per-window)
      ✓ bound to the policyVersion set at grant time
      ✓ nonce not replayed
  - Tx executes on Base.
  - Emit audit event: action.executed
```

#### Step 8: Audit Anchors

```
Audit Layer:
  - Append event to per-tenant hash chain.
  - Continue building Merkle tree for the current batch.

Anchorer:
  - Hourly:
      Compute Merkle root.
      EIP-712 sign with anchorer key.
      Submit to BrainAuditAnchor on Base L2.
  - On-chain: RootAnchored event emitted.
```

### End-to-End Provenance

Every step links back to every previous step.

```
Settlement receipt
         └── Action executed
         └── Recorded member approval
               └── Policy verdict (v3)
                     └── Wiki citations
                           └── Ledger records
                                 └── Raw artifacts (Azure Blob SHA-256 hashes)
```

A single Merkle proof against an anchored root verifies the entire chain.

{% hint style="success" %}
There is no point in this flow where Brain holds funds. Money moves directly between the tenant's accounts and counterparties on the tenant's chosen rails.
{% endhint %}

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Tenant Isolation</strong></td><td>How tenants are separated at every layer.</td><td><a href="tenant-isolation.md">tenant-isolation.md</a></td><td></td></tr><tr><td><strong>Security and Compliance</strong></td><td>Non-negotiable principles and compliance posture.</td><td><a href="security-and-compliance.md">security-and-compliance.md</a></td><td></td></tr><tr><td><strong>BrainSmartAccount</strong></td><td>The on-chain validator.</td><td><a href="../smart-contracts/brainsmartaccount.md">brainsmartaccount.md</a></td><td></td></tr></tbody></table>
