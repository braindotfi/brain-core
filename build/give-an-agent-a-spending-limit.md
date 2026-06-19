---
description: Define a policy in plain English. Brain enforces it on every proposed action.
---

# Give an Agent a Spending Limit

Goal: write a sentence in English describing what an agent (or human user) can do with a tenant's money. Brain compiles it to a deterministic rule, signs it with the tenant's key, and enforces it on every proposed action.

### The Simplest Policy

```typescript
const policy = await brain.policy.create("acme", {
  text:
    "Allow invoice payments under $5,000 to approved vendors. " +
    "Require CFO approval above $5,000. " +
    "Block payments to new counterparties without review.",
});

await brain.policy.activate(policy.id);
```

That's the whole flow. From this point on, every `brain.pay` call evaluates against this policy.

{% hint style="warning" %}
**Plain-English authoring is the intended experience, but not yet wired.** Today, policies are authored as **structured JSON DSL**, not prose; there is no natural-language compile step on either the SDK or the HTTP API. The real SDK call is `brain.policy.compose(tenantId, dsl)` (also exposed as `create`): it **validates the DSL** and returns the EIP-712 signing payload, which you then submit via `brain.policy.sign(...)` (also exposed as `activate`, which takes signatures, not a policy id). Non-SDK callers POST the same DSL to `/policy/{tenant_id}/compose`. See the [Policy API](../api-reference/policy-api.md#compose-a-candidate-policy) for the JSON shape. Treat the `{ text: "…" }` form below as illustrative of intent until NL authoring ships.
{% endhint %}

### Reviewing What Got Compiled

The compiler returns the structured rules and a human-readable explanation. Always review before activating.

```typescript
console.log(policy.explanation);
// This policy will:
//  - Auto-approve payments under $5,000 to vendors marked as approved
//  - Escalate payments at or above $5,000 to anyone with the CFO role
//  - Reject all payments to counterparties not yet on the approved list

console.log(policy.rules);
// [
//   { if: "amount < 5000 && counterparty.known", then: "auto" },
//   { if: "amount >= 5000 && counterparty.known", then: "needs_approval", approvers: ["role:cfo"] },
//   { if: "!counterparty.known", then: "rejected", reason: "new_counterparty_review_required" }
// ]
```

If the explanation matches your intent, activate. If not, edit the text and recompile.

### Trying It Before You Ship It

Dry-run a hypothetical action against the active policy.

```typescript
const decision = await brain.policy.evaluate("acme", {
  type:           "pay_invoice",
  amount:         7800,
  currency:       "USD",
  counterpartyId: "cp_vendor_x",
});

console.log(decision.outcome);     // "auto" | "needs_approval" | "rejected"
console.log(decision.matchedRule); // which rule fired
console.log(decision.approvers);   // populated if needs_approval
```

`evaluate` doesn't create a payment intent. It just shows you what would happen. Useful for testing edge cases before activating.

{% hint style="info" %}
`decision.outcome` returns the SDK aliases `auto | needs_approval | rejected`. Over HTTP/MCP the same decision is the canonical `allow | confirm | reject`, and the rule's `then` (`execute`) field uses `auto | confirm | reject`. The three vocabularies map 1:1; see [Policy → decision vocabulary across surfaces](../api-reference/policy-api.md#decision-vocabulary-across-surfaces).
{% endhint %}

### Approvers

Approvers are referenced by role or user.

```typescript
"Allow invoice payments under $5,000.
 Require CFO approval above $5,000.
 Require both CFO and CEO approval above $50,000."
```

| Reference               | Matches                               |
| ----------------------- | ------------------------------------- |
| `role:cfo`              | Anyone in your team with the CFO role |
| `role:cfo + role:ceo`   | Both must sign                        |
| `user:user_cfo`         | A specific user                       |
| `any:role:cfo,role:ceo` | Either CFO or CEO                     |

### Approving Counterparties

Many policies key off "approved vendors." Mark counterparties as approved through the SDK or the Console.

```typescript
await brain.counterparties.update("acme", "cp_vendor_x", {
  status: "approved",
});
```

Once approved, payments to this counterparty fall under the "approved vendor" branch of the policy.

### Multiple Environments

Policies are per-tenant, per-environment. Sandbox and production each have their own active policy. You'll typically:

| Environment    | Policy approach                                                   |
| -------------- | ----------------------------------------------------------------- |
| **Sandbox**    | Loose (high limits, few required approvers) for testing           |
| **Production** | Tight (low limits, multiple approvers, narrower vendor allowlist) |

### Updating a Policy

Policies are versioned. New text creates a new version that supersedes the old one.

```typescript
const v2 = await brain.policy.create("acme", {
  text: "..."  // new policy text
});

await brain.policy.activate(v2.id);
```

The old version is automatically deactivated. Past actions remain bound to the version that was active when they were proposed; you can always see which version evaluated which action by reading the action's metadata.

### What Policy Can Express

| Concept                           | Example                                        |
| --------------------------------- | ---------------------------------------------- |
| **Amount thresholds**             | "above $5,000", "between $1,000 and $10,000"   |
| **Counterparty status**           | "approved vendors", "new counterparties"       |
| **Counterparty type**             | "to employees", "to tax authorities"           |
| **Account balance preconditions** | "if the account balance is at least $50,000"   |
| **Time windows**                  | "between 9am and 5pm Pacific", "weekdays only" |
| **Approval requirements**         | "require approval from", "with sign-off by"    |
| **Outright denial**               | "block", "do not allow", "reject"              |

### What Policy Can't Express in Plain English (Yet)

Edge cases that need precise semantics. For these, you can author rules directly. See Policy in the Protocol section for the rule grammar.

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>💸 Pay an Invoice</strong></td><td>Watch the policy you just wrote enforce itself.</td><td><a href="pay-an-invoice-safely.md">pay-an-invoice-safely.md</a></td><td></td></tr><tr><td><strong>📜 Audit Trail</strong></td><td>Every policy decision lands in the audit log.</td><td><a href="audit-every-action.md">audit-every-action.md</a></td><td></td></tr></tbody></table>
