# Policy

The `brain.policy` namespace covers the full policy lifecycle: write, compile, simulate, sign, anchor, and update.

### Write a Policy

You write the policy in plain English. The compiler produces deterministic JSON plus a human-readable explanation.

```typescript
const policy = await brain.policy.create({
  tenantId: "acme",
  text: `
    Allow invoice payments under $5,000 to approved vendors,
    require approval above $5,000,
    and block payments to new counterparties without review.
  `,
});

policy.id;             // policy ID, not yet signed
policy.compiled;       // deterministic JSON
policy.explanation;    // human-readable summary
policy.policy_hash;    // bytes32 canonical hash
policy.status;         // "draft"
```

### Inspect the Compiled Form

```typescript
console.log(JSON.stringify(policy.compiled, null, 2));
```

Output:

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

### Simulate Before Signing

Test the policy against representative actions before committing to it.

```typescript
const sim = await brain.policy.simulate(policy.id, {
  action: {
    type: "pay_invoice",
    counterparty: { status: "approved", known: true },
    amount: 7800,
  },
});

sim.decision;   // "ESCALATE"
sim.reason;     // structured reason
sim.approvers;  // ["role:cfo"]
sim.matched_rule_index;  // 1 (zero-indexed)
```

Run the simulator across a batch of historical proposals to see how the new policy would have decided in each case.

```typescript
const recent = await brain.agents.recentProposals({
  tenantId: "acme",
  limit: 100,
});

const wouldDecide = await Promise.all(
  recent.map(p => brain.policy.simulate(policy.id, { action: p.action }))
);
```

### Sign and Anchor

```typescript
import { signPolicyRegistration } from "@brain/sdk";

const sig = await signPolicyRegistration({
  tenantId:    "acme",
  version:     1n,
  policyHash:  policy.policy_hash,
  notBefore:   0n,
  notAfter:    0n,         // 0 = no expiry
  nonce:       0n,
  signer:      yourSigner,
});

const registered = await brain.policy.sign(policy.id, {
  signature: sig,
});

registered.status;          // "active"
registered.version;         // 1
registered.anchored_tx_hash; // Base tx where the policy hash was registered
```

[**→ PolicyRegistration EIP-712 type**](../smart-contracts-old/brainpolicyregistry.md)

### Get the Active Policy

```typescript
const active = await brain.policy.getActive("acme");

active.version;
active.policy_hash;
active.compiled;
active.signed_at;
active.anchored_tx_hash;
```

### Evaluate a Hypothetical Action

```typescript
const verdict = await brain.policy.evaluate({
  tenantId: "acme",
  action: {
    type: "pay_invoice",
    counterparty: { status: "approved", known: true },
    amount: 4500,
  },
});

verdict.decision;        // "ALLOW"
verdict.policy_version;  // 1
verdict.signed_verdict;  // Signed verdict, can be attached to a UserOp
verdict.expires_at;      // 60 seconds from now (default TTL)
```

### Update a Policy

Updates are versioned. The previous version remains queryable for audit.

```typescript
const v2 = await brain.policy.create({
  tenantId: "acme",
  text: `
    Allow invoice payments under $10,000 to approved vendors,
    require approval above $10,000,
    and block payments to new counterparties without review.
  `,
});

await brain.policy.sign(v2.id, { signature: newSig });
// v2 is now active. v1 is available via brain.policy.getVersion("acme", 1)
```

### Revoke a Policy

```typescript
await brain.policy.revoke({
  tenantId: "acme",
  version: 1n,
  signer: yourSigner,
});
```

Revoking an active policy puts the tenant in a state where no actions can ALLOW until a new policy is signed and anchored. **All actions ESCALATE during this window.** This is by design. A tenant without an active policy is still safe.

{% hint style="warning" %}
Updates take effect after on-chain anchoring. There may be a brief window between signing locally and anchor confirmation. The SDK reports `anchored_tx_hash` once the registration transaction is confirmed.
{% endhint %}
