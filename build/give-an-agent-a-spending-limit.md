---
description: Define and sign a structured policy that Brain evaluates for every action.
---

# Give an Agent a Spending Limit

Goal: author a structured policy, collect the required signatures, then evaluate
actions against the active policy.

### Compose a Policy

Policy authoring uses the structured JSON DSL. Brain does not currently compile
plain English into a policy.

```typescript
const policy = await brain.policy.compose("tnt_acme", {
  version: 1,
  lists: {
    trusted_vendors: ["cp_acme_legal"],
  },
  rules: [
    {
      id: "small-trusted-payments",
      applies_to: ["outbound_payment"],
      when: {
        counterparty_in: "trusted_vendors",
        amount_lte: { currency: "USD", value: 5000 },
      },
      execute: "auto",
    },
    {
      id: "other-payments-require-review",
      applies_to: ["outbound_payment"],
      when: {},
      require: ["signer"],
      execute: "confirm",
    },
  ],
});

console.log(policy.policyId, policy.state, policy.signingPayload);
```

### Submit Signatures

Sign the returned payload with the authorized tenant member keys, then submit
the resulting signatures.

```typescript
const result = await brain.policy.sign("tnt_acme", {
  policyId: policy.policyId,
  signatures: [
    { address: signerAddress, signature: signerSignature },
  ],
});

console.log(result.activated, result.policy.version);
```

`compose` returns `policyId`, `state`, and `signingPayload`. Policy activation
happens as a side effect of `sign` once the required signatures are present.

### Test an Action

```typescript
const decision = await brain.policy.evaluate("tnt_acme", {
  kind: "outbound_payment",
  amount: { currency: "USD", value: "7800" },
  counterparty_id: "cp_acme_legal",
  agent_role: "payment",
});

console.log(decision.outcome);
console.log(decision.matched_rule_id);
console.log(decision.required_approvers);
```

`outcome` is exactly `allow`, `confirm`, or `reject`. It is not an SDK alias
layer. This request records a `policy.evaluate` audit event, but it does not
create a payment intent.

### Approval Requirements

Policy `require` contains the roles whose approvals the rule needs.

```typescript
const dualApprovalRule = {
  id: "large-payment",
  applies_to: ["outbound_payment"],
  when: {
    amount_gt: { currency: "USD", value: 50000 },
  },
  require: ["cfo", "ceo"],
  execute: "confirm",
};
```

### Update a Policy

Policies are versioned. Compose a new document with the next version, then
submit signatures for that new `policyId`.

```typescript
const next = await brain.policy.compose("tnt_acme", {
  version: 2,
  lists: {},
  rules: [dualApprovalRule],
});

await brain.policy.sign("tnt_acme", {
  policyId: next.policyId,
  signatures: [{ address: signerAddress, signature: signerSignature }],
});
```

### What's Next

- [Pay an Invoice Safely](pay-an-invoice-safely.md)
- [Audit Every Action](audit-every-action.md)
