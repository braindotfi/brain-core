---
description: Propose a payment, route to approval if needed, execute, get a receipt.
---

# Pay an Invoice Safely

Goal: pay an invoice with a single SDK call. If it's within the tenant's policy, it goes through. If not, it routes to a human approver. Either way, you get a receipt you can show a customer.

### The Simplest Case

```typescript
const action = await brain.pay("acme", { invoiceId: "inv_8231" });

console.log(action.status);
// "auto"           → already executed
// "needs_approval" → waiting for a human
// "rejected"       → policy said no
```

{% hint style="info" %}
`action.status` uses the SDK aliases `auto | needs_approval | rejected`. The HTTP PaymentIntent lifecycle uses `approved | pending_approval | rejected | executed | …` for the same states (`auto` ⇒ `approved`/`executed`). See the [mapping table](../api-reference/payment-intents-api.md#status-lifecycle).
{% endhint %}

### Handling All Three Outcomes

```typescript
const action = await brain.pay("acme", { invoiceId: "inv_8231" });

switch (action.status) {
  case "auto":
    // Already done. Brain executed and recorded the receipt.
    console.log("paid:", action.receipt.txHash ?? action.receipt.railReceipt);
    break;

  case "needs_approval":
    // Surface to your approval UI. Approvers receive the action.
    console.log("waiting on:", action.approvers);
    break;

  case "rejected":
    console.log("blocked:", action.reason);
    break;
}
```

### Approving from Your App

```typescript
// In your approval UI, signed by the approver's key.
await brain.approve(actionId, { as: "user_cfo" });
```

`approve` records the typed signature. Once all required approvers have signed, the intent becomes `approved` and Brain's internal settlement path runs the §6 gate and dispatches it; you do not call a separate execute step, and the approver's signature is not itself a settlement call. The action's status moves from `needs_approval` to `auto`.

For multi-approver policies, every required approver calls `brain.approve`. Brain holds the action in `needs_approval` until the last one lands.

### Rejecting from Your App

```typescript
await brain.reject(actionId, {
  as:     "user_cfo",
  reason: "Vendor under review",
});
```

Rejection is final. The action moves to `rejected` and emits a webhook your app can react to.

### Getting the Receipt

Every executed action has a verifiable receipt.

```typescript
const proof = await brain.proof(actionId);

proof.txHash;       // on-chain tx for on-chain rails (Base)
proof.railReceipt;  // bank receipt for ACH/wire
proof.merklePath;   // Merkle path to the on-chain anchor
proof.anchorTx;     // anchor transaction on Base L2
```

If you ever need to prove to a customer that a payment happened, this is the thing to send them. They can verify it without a Brain account.

### Paying Without an Invoice

Sometimes you're paying something that isn't a structured invoice yet (a vendor name and an amount, say). Pass the destination directly.

```typescript
const action = await brain.pay("acme", {
  to:        { counterpartyId: "cp_acme_legal" },
  amount:    "12500.00",
  currency:  "USD",
  memo:      "Q3 retainer",
});
```

Brain still runs every check it would run for an invoice payment.

### Idempotency

Always pass an idempotency key. Retries with the same key return the existing action instead of creating a duplicate.

```typescript
const action = await brain.pay("acme", {
  invoiceId:      "inv_8231",
  idempotencyKey: "pay_inv_8231_2025_09",
});
```

If your service crashes mid-call and your retry handler fires, you'll get the same action back. No duplicate payments.

### Webhooks for Long-Running Flows

Most ACH and wire payments don't settle instantly. Subscribe to the action's lifecycle.

Outbound webhooks use the `payment_intent.*` event names (the same `event_type` values the [Webhooks API](../api-reference/webhooks-api.md) lists), not an `action.*` namespace:

| `event_type`                   | When                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `payment_intent.created`       | Just after `brain.pay` returns (intent proposed)                            |
| `payment_intent.approved`      | All required approvers have signed (or Policy returned `allow`)             |
| `payment_intent.rejected`      | Policy or an approver rejected                                              |
| `payment_intent.execute.after` | The §6 gate ran and the intent was dispatched to its rail                   |

{% hint style="info" %}
Settlement is asynchronous and there is **no** dedicated `payment_intent.settled` / `payment_intent.failed` outbound event today. `payment_intent.execute.after` fires when the intent is dispatched; final rail settlement (or failure) is observed via the rail-specific provider webhook and confirmed through [`GET /v1/proof/{action_id}`](../api-reference/proof-api.md) / replay-investigation.
{% endhint %}

```typescript
// Webhook handler
app.post("/webhooks/brain", verifyBrainSig, (req, res) => {
  const event = req.body;
  switch (event.event_type) {
    case "payment_intent.execute.after":
      markInvoiceDispatched(event.data.invoiceId);
      break;
  }
  res.sendStatus(200);
});
```

### What if My Action Fails?

Brain returns a structured failure code and never silently retries.

```json
{
  "status": "failed",
  "reason": "INSUFFICIENT_BALANCE",
  "details": {
    "required":  "61404.12 USD",
    "available": "58901.04 USD",
    "accountId": "acct_ops"
  }
}
```

You can re-propose with a different source account, a different amount, or wait until the balance covers it.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🛡 Spending Limits</strong></td><td>Define what counts as "needs approval" in plain English.</td><td><a href="give-an-agent-a-spending-limit.md">give-an-agent-a-spending-limit.md</a></td><td></td></tr><tr><td><strong>📜 Audit Trail</strong></td><td>Pull the full record of what happened and why.</td><td><a href="audit-every-action.md">audit-every-action.md</a></td><td></td></tr></tbody></table>
