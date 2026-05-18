# Policy and Permissioning

Tenants describe policy in **plain English**. The Policy compiler converts each policy into a deterministic guard expression that is evaluated for every proposed action. Policies are versioned and signed by the tenant via EIP-712, with hashes anchored on-chain through `BrainPolicyRegistry`.

### Plain English in, Deterministic Guard Out

You write the policy in natural language. Brain compiles it. You sign the compiled form, not the prose.

```
Allow invoice payments under $5,000 to approved vendors,
require approval above $5,000,
and block payments to new counterparties without review.
```

Compiles to:

```json
{
  "subject":  { "agent_capability": "pay_invoice" },
  "resource": { "counterparty.status": ["approved"] },
  "rules": [
    { "if": "amount < 5000 && counterparty.known",
      "then": "ALLOW" },
    { "if": "amount >= 5000 && counterparty.known",
      "then": "ESCALATE", "approvers": ["role:cfo"] },
    { "if": "!counterparty.known",
      "then": "DENY", "reason": "new_counterparty_review_required" }
  ]
}
```

{% hint style="warning" %}
The compiler emits both the deterministic compiled policy **and** a human-readable explanation of what it will do. **Tenants sign the compiled form, not the prose.** This eliminates ambiguity at the moment of signing.
{% endhint %}

### The Five Elements of a Policy

Every policy has five elements.

<table><thead><tr><th width="200">Element</th><th>What It Defines</th></tr></thead><tbody><tr><td><strong>Subjects</strong></td><td>Which agents, capabilities, or roles the policy applies to</td></tr><tr><td><strong>Resources</strong></td><td>Which accounts, counterparties, asset classes, or jurisdictions are in scope</td></tr><tr><td><strong>Actions</strong></td><td>What is permitted: read, propose, execute, approve</td></tr><tr><td><strong>Conditions</strong></td><td>Thresholds, time windows, frequency caps, required approvers</td></tr><tr><td><strong>Outcomes</strong></td><td>ALLOW, DENY, or ESCALATE</td></tr></tbody></table>

### The Three Outcomes

Every policy evaluation produces exactly one of three outcomes.

<table data-view="cards"><thead><tr><th></th><th></th></tr></thead><tbody><tr><td><strong>✅ ALLOW</strong></td><td>The action proceeds. A signed policy verdict is attached to the resulting UserOperation or rail call.</td></tr><tr><td><strong>⚠️ ESCALATE</strong></td><td>Human approval is required before the action can execute. The verdict names the required approvers (e.g. <code>role:cfo</code>).</td></tr><tr><td><strong>❌ DENY</strong></td><td>The action is blocked. The verdict carries a structured reason (e.g. <code>new_counterparty_review_required</code>).</td></tr></tbody></table>

{% hint style="info" %}
**ESCALATE is the default for unmatched conditions.** If the policy compiler cannot determine a clear ALLOW or DENY for a proposed action, the safe default is to require human review. Failure modes are explicit, not silent.
{% endhint %}

### Worked Example: The $7,800 invoice

A walkthrough of the policy from the top of this page, applied to a real proposal:

<table><thead><tr><th width="100">Step</th><th>What Happens</th></tr></thead><tbody><tr><td>1</td><td>Agent proposes: pay $7,800 invoice to Vendor X</td></tr><tr><td>2</td><td>Policy Layer evaluates against version <code>v3</code> of the tenant policy</td></tr><tr><td>3</td><td>Counterparty Vendor X: known, status = approved</td></tr><tr><td>4</td><td>Amount $7,800: above $5,000 threshold</td></tr><tr><td>5</td><td>Outcome: <code>ESCALATE_FOR_APPROVAL</code>, approvers = <code>[role:cfo]</code></td></tr><tr><td>6</td><td>CFO receives the request with Wiki context (vendor history, prior payments) and Ledger references (invoice, PO)</td></tr><tr><td>7</td><td>CFO approves. EIP-712 approval signature recorded</td></tr><tr><td>8</td><td>Action moves to executable. <code>BrainSmartAccount</code> signs UserOperation OR bank API call dispatched</td></tr><tr><td>9</td><td>Audit Layer records: proposal, policy decision, approver identity, execution receipt, settlement confirmation, all linked by hash</td></tr></tbody></table>

### Versioning, Signing, and Anchoring

Every policy version has a lifecycle.

```
draft → compile → review → sign (EIP-712) → anchor on-chain → active
```

<table><thead><tr><th width="150">Phase</th><th>What Happens</th></tr></thead><tbody><tr><td><strong>Draft</strong></td><td>Plain-English text written in the Console or via API</td></tr><tr><td><strong>Compile</strong></td><td>Compiler produces deterministic JSON + a human-readable explanation</td></tr><tr><td><strong>Review</strong></td><td>Tenant reviews the compiled form</td></tr><tr><td><strong>Sign</strong></td><td>Tenant signs the canonical hash via EIP-712 <code>PolicyRegistration</code></td></tr><tr><td><strong>Anchor</strong></td><td>Hash is registered in <code>BrainPolicyRegistry</code> on Base L2</td></tr><tr><td><strong>Active</strong></td><td>The policy version is active until superseded or revoked</td></tr></tbody></table>

The signed structure:

```
PolicyRegistration(
  bytes32 tenantId,
  uint64  version,
  bytes32 policyHash,
  uint64  notBefore,
  uint64  notAfter,
  uint256 nonce
)
```

**→ Smart contract reference**

### How Policy Enforcement is Layered

Policy is enforced **twice** by design.

<table><thead><tr><th width="250">Level</th><th>What It Catches</th></tr></thead><tbody><tr><td><strong>Off-chain</strong> Brain Policy Engine</td><td>Most evaluations, fast feedback, dynamic conditions, rich error messages</td></tr><tr><td><strong>On-chain</strong> <code>BrainSmartAccount</code></td><td>The signed Policy verdict is verified inside <code>validateUserOp</code>. Any action without a valid verdict is rejected at the account level, regardless of what the off-chain engine said.</td></tr></tbody></table>

{% hint style="success" %}
Belt and braces. Even if the off-chain engine were compromised, the on-chain account would still reject UserOperations that lack a valid, non-expired, scope-bound policy verdict.
{% endhint %}

Policy verdicts are short-lived (default TTL 60 seconds) and bound to the `userOpHash`, so a verdict cannot be replayed against a different action.
