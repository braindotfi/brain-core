---
description: Create a PaymentIntent, route it through approval when needed, then execute it.
---

# Pay an Invoice Safely

Goal: create a payment intent, respect the tenant policy decision, and execute
only an approved intent through the section 6 gate.

### Create an Invoice Payment

```typescript
const intent = await brain.payments.create({
  type: "pay_invoice",
  invoice_id: "inv_8231",
  idempotencyKey: "example-idempotency-key-1",
});

console.log(intent.id, intent.status, intent.policy_decision_id);
```

The API derives the tenant from the credential. The idempotency key is sent as
the `Idempotency-Key` header.

### Handle the Policy Result

```typescript
if (intent.status === "approved" && intent.id) {
  const execution = await brain.payments.execute(intent.id);
  console.log(execution.paymentIntentId, execution.outboxId, execution.status);
} else if (intent.status === "pending_approval" && intent.id) {
  console.log("waiting for a member approval", intent.id);
} else if (intent.status === "rejected") {
  console.log("policy rejected the payment", intent.policy_decision_id);
}
```

The convenience helper `brain.pay("current-tenant", params)` creates the same
intent. It throws `PolicyApprovalRequiredError` for `pending_approval` and
`PolicyRejectedError` for `rejected`. On an immediately approved intent, it
executes the intent and returns `{ intent, execution }`.

### Approve, Then Execute

Approval and execution are separate calls. A second distinct approver may be
required before the intent becomes `approved`.

```typescript
const afterApproval = await brain.payments.approve("pi_8231");

if (afterApproval.status === "approved" && afterApproval.id) {
  const execution = await brain.payments.execute(afterApproval.id);
  console.log(execution.rail, execution.status);
}
```

### Create a Standard Payment

```typescript
const intent = await brain.payments.create({
  action_type: "ach_outbound",
  source_account_id: "acct_operations",
  destination_counterparty_id: "cp_acme_legal",
  amount: "12500.00",
  currency: "USD",
  idempotencyKey: "example-idempotency-key-2",
});
```

### Get a Verifiable Proof

```typescript
const proof = await brain.proof("pi_8231");

console.log(proof.merkle_root);
console.log(proof.merkle_proof);
console.log(proof.rail_receipt);
console.log(proof.chain_anchor?.tx_hash);
```

The proof contains the Merkle root and proof, any rail receipt, and the
Base Sepolia chain anchor when one is available.

### Receive Lifecycle Webhooks

| Event | Meaning |
| --- | --- |
| `payment_intent.created` | The intent was created |
| `payment_intent.approved` | Required human approvals completed |
| `payment_intent.rejected` | Policy or an approver rejected the intent |
| `payment_intent.execute.after` | The section 6 gate evaluated before dispatch |
| `payment_intent.executed` | The rail completed the payment |
| `payment_intent.failed` | The rail failed deterministically |

```typescript
app.post("/webhooks/brain", verifyBrainSignature, (request, response) => {
  const event = request.body;
  if (event.type === "payment_intent.executed") {
    markInvoicePaid(event.data);
  }
  response.sendStatus(200);
});
```

### Handle a Failure

Payment and gate failures use lowercase snake-case error codes, returned in
the standard error envelope:

```json
{
  "error": {
    "code": "insufficient_balance",
    "message": "source account balance is insufficient for this payment",
    "request_id": "req_8231",
    "docs_url": "https://docs.brain.fi/resources/errors#insufficient_balance"
  }
}
```

### What's Next

- [Give an Agent a Spending Limit](give-an-agent-a-spending-limit.md)
- [Audit Every Action](audit-every-action.md)
