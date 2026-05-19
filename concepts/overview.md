---
description: The mental model in five minutes.
---

# Overview

Brain is one API for autonomous financial operations. Underneath, it does four things, in this order, every time:

```
remember   →   decide   →   execute   →   prove
```

| Word         | What Brain does                                                                                             | What you call it                       |
| ------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Remember** | Pulls in evidence from banks, ERPs, processors, on-chain wallets, and structures it into a queryable record | `brain.ask`, `brain.transactions.list` |
| **Decide**   | Evaluates every proposed action against rules the tenant signed                                             | runs automatically inside `brain.pay`  |
| **Execute**  | Dispatches the action through the right rail (ACH, ERP write, on-chain)                                     | `brain.pay`, `brain.approve`           |
| **Prove**    | Records every step in a tamper-evident log anchored on Base L2                                              | `brain.proof`, `brain.audit.list`      |

Everything else in this documentation is depth on those four steps.

### Why this matters

Most fintech infrastructure stops at execution. The provider moves the money and confirms it landed. That leaves the integrating application to handle context, rules, and audit on its own. Brain is built around the fact that agents need all four steps, in order, on every action.

| Without remember           | Without decide            | Without execute        | Without prove                     |
| -------------------------- | ------------------------- | ---------------------- | --------------------------------- |
| Agent acts on partial data | Agent acts outside policy | Agent can't move money | Agent's actions can't be verified |

### The four ideas in detail

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>🧠 Memory</strong></td><td>What Brain knows about a tenant, where it came from, and how to query it.</td><td><a href="memory.md">memory.md</a></td><td></td></tr><tr><td><strong>🛡 Policy</strong></td><td>The rules a tenant signed. How decisions are made.</td><td><a href="policy.md">policy.md</a></td><td></td></tr><tr><td><strong>🤖 Agents</strong></td><td>Who can read, propose, and act. Internal and external.</td><td><a href="agents.md">agents.md</a></td><td></td></tr><tr><td><strong>📜 Proof</strong></td><td>Why every claim Brain makes is verifiable.</td><td><a href="proof.md">proof.md</a></td><td></td></tr></tbody></table>

### Tenants

Everything in Brain happens **for a tenant**. A tenant is a customer of yours: a business, a workspace, a user. Brain isolates tenants at the storage, key, and policy layer.

```typescript
await brain.ask("acme", "...");        // for tenant "acme"
await brain.pay("acme", { ... });      // also "acme"
await brain.audit.list("acme", { ... }); // also "acme"
```

Cross-tenant access is impossible by construction. You'll never see one tenant's data accidentally surface in another tenant's response.

### Provenance

Every fact Brain returns carries citations.

```typescript
const answer = await brain.ask("acme", "What did we spend on AWS last month?");

answer.text;        // a natural-language answer
answer.citations;   // pointers back to the specific transactions, invoices, or evidence that produced the answer
```

You never have to take Brain's word for anything. Every claim links back to source evidence.

### Idempotency

Every mutating call accepts (and most require) an idempotency key.

```typescript
await brain.pay("acme", {
  invoiceId:      "inv_8231",
  idempotencyKey: "pay_inv_8231_2025_09",
});
```

Retries with the same key return the existing action, so a network blip never produces a duplicate payment.

### Where the depth lives

When you're ready, the protocol underneath has more to offer. Each of those concepts maps to a specific layer.

| Concept | Layer (deep dive)                 |
| ------- | --------------------------------- |
| Memory  | Raw, Ledger, and Wiki             |
| Policy  | Policy and the pre-execution gate |
| Agents  | The Agent layer                   |
| Proof   | Audit and on-chain anchoring      |

You can build with Brain without reading any of those sections. They are there when you want the deeper view.
