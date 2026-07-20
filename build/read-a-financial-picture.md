---
description: Pull balances, transactions, obligations, and counterparties for a tenant.
---

# Read a Financial Picture

Goal: get a structured view of a tenant's full financial state, ready to render in a dashboard or feed to an LLM.

### In One Call

```typescript
const picture = await brain.snapshot("acme");

picture.accounts;        // [{ id, name, currency, currentBalance, ... }]
picture.transactions;    // recent, paginated
picture.obligations;     // upcoming, due, overdue
picture.counterparties;  // top counterparties by activity
picture.cashFlow;        // 30-day inflow/outflow summary
```

`brain.snapshot` is a convenience wrapper. It runs a handful of underlying calls in parallel and stitches the response together. For full control, call them yourself.

### In Five Calls

```typescript
const [accounts, transactions, obligations, counterparties, cashFlow] = await Promise.all([
  brain.accounts.list("acme"),
  brain.transactions.list("acme", { from: "2025-09-01", limit: 100 }),
  brain.obligations.list("acme", { status: ["upcoming", "due", "overdue"] }),
  brain.counterparties.list("acme", { sortBy: "activity", limit: 20 }),
  brain.cashFlow.summarize({ tenantId: "acme", since: "2025-09-01", until: "2025-09-30" }),
]);
```

### Filtering Transactions

```typescript
const txns = await brain.transactions.list("acme", {
  from: "2025-09-01",
  to:   "2025-09-30",
  direction:       "outflow",       // inflow | outflow | transfer | adjustment
  counterpartyId:  "cp_aws",
  minAmount:       100,
  status:          ["posted", "cleared"],
  limit:           50,
});

txns.data.forEach((t) => console.log(t.date, t.amount, t.description));
console.log(txns.nextCursor);
```

| Filter                   | Type     | Notes                                                            |
| ------------------------ | -------- | ---------------------------------------------------------------- |
| `from`, `to`             | ISO date | Inclusive                                                        |
| `direction`              | enum     | One or many                                                      |
| `counterpartyId`         | string   | Filter to one counterparty                                       |
| `accountId`              | string   | Filter to one account                                            |
| `minAmount`, `maxAmount` | decimal  | Currency-agnostic                                                |
| `currency`               | ISO 4217 | When mixing currencies                                           |
| `status`                 | enum\[]  | `pending`, `posted`, `cleared`, `failed`, `reversed`, `disputed` |

### Asking Questions Instead of Querying

Sometimes you don't know what to filter on. Ask in natural language.

```typescript
const answer = await brain.ask("acme", "Which counterparties did we pay the most in Q3?");
console.log(answer.text);
console.log(answer.citations);  // ledger references back to specific transactions
```

The answer comes with citations to the specific transactions it cites. You can render those in your UI as clickable proof.

### Paginating

All list endpoints return a `nextCursor`. Pass it on the next call.

```typescript
let cursor: string | undefined;
do {
  const page = await brain.transactions.list("acme", { from: "2025-01-01", cursor, limit: 200 });
  for (const t of page.data) {
    // process
  }
  cursor = page.nextCursor;
} while (cursor);
```

### Getting Notified of Changes

Instead of polling, use webhooks. Set the endpoint in the Console under Settings → Webhooks.

| Event                     | Payload                                 |
| ------------------------- | --------------------------------------- |
| `transaction.created`     | The new transaction                     |
| `transaction.updated`     | Status, amount, or counterparty changed |
| `account.balance_changed` | New balance for an account              |
| `obligation.due_soon`     | An obligation is N days from due        |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>💸 Pay an Invoice</strong></td><td>Take action on what you just read.</td><td><a href="pay-an-invoice-safely.md">pay-an-invoice-safely.md</a></td><td></td></tr><tr><td><strong>🛡 Spending Limits</strong></td><td>Let an agent read and act, with guardrails.</td><td><a href="give-an-agent-a-spending-limit.md">give-an-agent-a-spending-limit.md</a></td><td></td></tr></tbody></table>
