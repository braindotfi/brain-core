---
description: Pull balances, transactions, obligations, and counterparties for the authenticated tenant.
---

# Read a Financial Picture

Goal: retrieve the authenticated tenant's current financial data for a dashboard or a grounded application workflow.

### Start With a Snapshot

`brain.snapshot` is an SDK convenience method. The tenant is derived from the
credential. Its compatibility argument is not sent to the API.

```typescript
const picture = await brain.snapshot("current-tenant");

picture.balances;
picture.recentTransactions;
picture.openObligations;
picture.asOf;
```

The snapshot contains balances, recent transactions, open obligations, and its
observation timestamp. Query the individual Ledger resources when the UI needs
additional entities or filters.

### Read Individual Resources

```typescript
const [accounts, transactions, obligations, counterparties, cashFlow] = await Promise.all([
  brain.accounts.list({ limit: 100 }),
  brain.transactions.list({ since: "2025-09-01T00:00:00.000Z", limit: 100 }),
  brain.obligations.list({ status: "due", limit: 100 }),
  brain.counterparties.list({ limit: 100 }),
  brain.cashFlow.getServerSummary({ days: 30 }),
]);
```

Every resource derives the tenant from the authenticated principal. List calls
take one optional parameter object, not a tenant identifier.

### Filter Transactions

```typescript
const page = await brain.transactions.list({
  since: "2025-09-01T00:00:00.000Z",
  until: "2025-09-30T23:59:59.999Z",
  direction: "outflow",
  counterparty_id: "cp_aws",
  status: "posted",
  limit: 50,
});

for (const transaction of page.transactions) {
  console.log(transaction.id, transaction.amount, transaction.currency);
}
console.log(page.nextCursor);
```

| Filter | Type | Notes |
| --- | --- | --- |
| `since`, `until` | ISO timestamp | Time range bounds |
| `direction` | enum | One of `inflow`, `outflow`, `transfer`, or `adjustment` |
| `counterparty_id` | string | One counterparty identifier |
| `account_id` | string | One account identifier |
| `status` | enum | One transaction status |
| `limit`, `cursor` | number, string | Keyset pagination |

### Ask a Grounded Question

```typescript
const answer = await brain.ask(
  "current-tenant",
  "Which counterparties did we pay the most in Q3?",
);

console.log(answer.answer);
for (const item of answer.evidence) {
  console.log(item.entityType, item.entityId, item.excerpt);
}
```

The response contains `answer` and the evidence records used to ground it. The
tenant argument is retained for SDK compatibility and is not sent on the wire.

### Paginate

```typescript
let cursor: string | null = null;

do {
  const page = await brain.transactions.list({
    since: "2025-01-01T00:00:00.000Z",
    limit: 200,
    ...(cursor ? { cursor } : {}),
  });

  for (const transaction of page.transactions) {
    console.log(transaction.id);
  }
  cursor = page.nextCursor;
} while (cursor);
```

### Receive Change Notifications

Configure audit webhooks for the forwarded event names your application needs.

| Event | Meaning |
| --- | --- |
| `ledger.transaction.created` | A transaction was written to the Ledger |
| `ledger.obligation.created` | An obligation was written to the Ledger |
| `ledger.counterparty.created` | A counterparty was created |
| `raw.extraction.status_changed` | A Raw extraction changed state |

### What's Next

- [Pay an Invoice Safely](pay-an-invoice-safely.md)
- [Give an Agent a Spending Limit](give-an-agent-a-spending-limit.md)
