# Create Your First Policy-Gated Action

Write a policy, register an agent, propose an action, watch it escalate, approve it, execute, and verify the on-chain audit proof. Every layer of the stack runs in this flow.

{% hint style="info" %}
You'll need a connected source from the previous step. The agent in this walkthrough proposes paying an invoice that the Wiki has surfaced from your sandbox data.
{% endhint %}

### What you'll build

```
1. Write policy in plain English        ──► registered on Base Sepolia
2. Register an internal payments agent   ──► visible in Agent Manager
3. Agent proposes an action              ──► Policy evaluates → ESCALATE
4. CFO role approves                     ──► EIP-712 signature recorded
5. Action executes through smart account ──► UserOp on Base Sepolia
6. Audit anchored                        ──► Merkle proof verifiable on-chain
```

### Step 1: Write a Policy

Policies are written in plain English. The Brain compiler converts them to deterministic guards.

```typescript
const policy = await brain.policy.create({
  tenantId: "acme",
  text:
    "Allow invoice payments under $5,000 to approved vendors. " +
    "Require approval from a CFO above $5,000. " +
    "Block payments to new counterparties without review.",
});

console.log(policy.compiled);
console.log(policy.explanation);
```

The compiler returns a JSON form and a human-readable explanation. Verify the explanation matches your intent.

```
This policy will:
  - Auto-approve payments under $5,000 to vendors marked as approved
  - Escalate payments at or above $5,000 to anyone with the CFO role
  - Reject all payments to counterparties not yet on the approved list
```

### Step 2: Register the Policy On-Chain

Sign and register the compiled hash.

```typescript
const registered = await brain.policy.register({
  tenantId:  "acme",
  policyId:  policy.policy_id,
});

console.log(registered.tx_hash); // Base Sepolia transaction
console.log(registered.version); // e.g., 1
```

The Console shows the new active policy under **Policy → Active** and links to the Base Sepolia explorer for the registration transaction.

### Step 3: Approve a Vendor

For the policy to allow a payment, the counterparty must be on the approved list.

```typescript
// Find the counterparty the Wiki created from your sandbox data
const vendors = await brain.wiki.search({
  tenantId: "acme",
  type:     "counterparty",
  limit:    5,
});

const vendor = vendors[0];
console.log(vendor.id, vendor.name);

// Mark them approved
await brain.ledger.counterparties.update({
  tenantId: "acme",
  id:       vendor.id,
  status:   "approved",
});
```

### Step 4: Register a Payments Agent

For sandbox, Brain ships an internal agent named `payments-v1`. Just grant it scope.

```typescript
const grant = await brain.agents.grantScope({
  tenantId:      "acme",
  agentId:       "payments-v1",
  capability:    "pay_invoice",
  maxAmount:     "10000_USD",
  resourceScope: "counterparties:approved",
  notBefore:     Math.floor(Date.now() / 1000),
  notAfter:      Math.floor(Date.now() / 1000) + 30 * 86400, // 30 days
});

console.log(grant.signature); // EIP-712 ScopeAttestation
```

### Step 5: Propose an Action

Pick an unpaid invoice from the sandbox data.

```typescript
const invoices = await brain.ledger.invoices.list({
  tenantId: "acme",
  status:   "unpaid",
  limit:    1,
});

const invoice = invoices.data[0];
console.log(invoice.id, invoice.amount, invoice.counterparty_id);

// Propose the payment
const proposal = await brain.agents.propose({
  tenantId: "acme",
  agentId:  "payments-v1",
  action:   {
    type:      "pay_invoice",
    invoiceId: invoice.id,
  },
});

console.log(proposal.decision);       // "ALLOW" | "DENY" | "ESCALATE"
console.log(proposal.actionId);
console.log(proposal.audit_event_id);
```

### Step 6: Handle the Decision

If the invoice is under $5,000 to an approved vendor, you'll see `ALLOW`. If it's at or above $5,000, the CFO role must approve.

```typescript
switch (proposal.decision) {
  case "ALLOW":
    await brain.actions.execute(proposal.actionId);
    break;

  case "ESCALATE":
    console.log("Approvers needed:", proposal.approvers);
    // The CFO sees this in the Console approval queue.
    break;

  case "DENY":
    console.log("Blocked:", proposal.reason);
    break;
}
```

For the walkthrough, force `ESCALATE` by picking an invoice over $5,000 (or temporarily lowering the policy threshold).

### Step 7: Approve as CFO

In the Console, switch to a teammate with the CFO role (or assign yourself). Open **Approvals**, see the pending action with full Wiki context (vendor history, prior payments) and Ledger references (the invoice and any related PO), then click **Approve**.

Programmatically:

```typescript
const approval = await brain.actions.approve({
  actionId:  proposal.actionId,
  approver:  "user_cfo",
  signature: cfoEip712Sig,  // signed off-chain by the CFO key
});
```

### Step 8: Execute

Once approved, execute. For sandbox, Brain routes to a test smart account on Base Sepolia.

```typescript
const result = await brain.actions.execute(proposal.actionId);

console.log(result.status);          // "succeeded"
console.log(result.path);             // "smart_account"
console.log(result.tx_hash);          // Base Sepolia tx
console.log(result.audit_event_id);
```

### Step 9: Verify the Audit Proof

Pull the Merkle proof for the execution event.

```typescript
const proof = await brain.audit.getProof({
  eventId: result.audit_event_id,
});

console.log(proof.merkle_path);
console.log(proof.anchored_root);
console.log(proof.base_tx_hash);  // Base Sepolia tx for the anchor batch
console.log(proof.base_block);
```

You can verify on-chain directly by calling `BrainAuditAnchor.verify()` against the proof, no Brain SDK required:

```solidity
bool valid = anchor.verify(
  proof.tenant_id_hash,
  proof.batch_index,
  proof.event_leaf,
  proof.merkle_path
);
// returns true
```

**→ BrainAuditAnchor reference**

### Trace the Whole Thing

In the Console, paste the original `traceId` (from `proposal`) into the search bar. You'll see the full timeline:

```
[ traceId: trc_a1b2c3...                                      ]
   ├─ Wiki context     12 Ledger refs, 3 Raw refs gathered
   ├─ Proposal         agent: payments-v1, action: pay_invoice
   ├─ Policy evaluated v1, decision: ESCALATE → CFO approval
   ├─ Approval         user_cfo, EIP-712 signature verified
   ├─ Execution        path: smart_account, UserOp submitted
   ├─ On-chain         tx 0xfeed... on Base Sepolia
   ├─ Audit anchored   batch 4127, root 0xab12... at block 9583122
   └─ Receipt          Merkle proof generated
```

Every step is hashed and linked. Any counterparty can verify any of these without seeing the underlying data.

### What Just Happened

You executed a real flow through every layer of the stack.

<table><thead><tr><th width="200">Layer</th><th>What Ran</th></tr></thead><tbody><tr><td><strong>Raw</strong></td><td>Plaid sandbox data ingested</td></tr><tr><td><strong>Ledger</strong></td><td>Invoice and counterparty records created</td></tr><tr><td><strong>Wiki</strong></td><td>Vendor history surfaced for the approver</td></tr><tr><td><strong>Policy</strong></td><td>Plain-English rule compiled, signed, anchored, evaluated</td></tr><tr><td><strong>Agent</strong></td><td><code>payments-v1</code> proposed, scope checked, action executed</td></tr><tr><td><strong>Audit</strong></td><td>Every step hashed, Merkle root anchored on Base Sepolia</td></tr></tbody></table>

### Where to Go Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🏗️ Six-Layer Stack</strong></td><td>Understand how each layer works internally.</td><td><a href="../core-concepts/the-six-layer-stack.md">the-six-layer-stack.md</a></td></tr><tr><td><strong>🛠️ SDK Reference</strong></td><td>Browse every namespace and method.</td><td><a href="/broken/pages/2Fzcb73UiK84NWebjDDa">Broken link</a></td></tr><tr><td><strong>📜 Smart Contracts</strong></td><td>The on-chain contracts you just used.</td><td><a href="/broken/pages/PG0yFmWSagIeaa7L5dY0">Broken link</a></td></tr></tbody></table>

### Going to Production

When you're ready to move from sandbox:

<table><thead><tr><th width="100">Step</th><th>Action</th></tr></thead><tbody><tr><td>1</td><td>Create a production tenant at <code>console.brain.fi</code></td></tr><tr><td>2</td><td>Generate production API keys (<code>brain_sk_live_...</code>)</td></tr><tr><td>3</td><td>Connect production sources with real credentials</td></tr><tr><td>4</td><td>Re-author and re-sign your policy in production (different <code>tenantId</code>, different anchor)</td></tr><tr><td>5</td><td>Register and scope agents in production</td></tr><tr><td>6</td><td>Configure account-level limits on the production smart account</td></tr><tr><td>7</td><td>Set up SSO and approval roles for your team</td></tr></tbody></table>

[**→ Security and Compliance** covers what changes in production: SOC 2, ISO 27001, data residency, anchor cadence, and key management.](../architecture/security-and-compliance.md)
