# Wiki

The `brain.wiki` namespace gives you natural-language access to the structured financial memory of a tenant. Every answer is cited.

### Ask a Question

```typescript
const answer = await brain.wiki.question({
  tenantId: "acme",
  question: "What did we spend on AWS last quarter, by environment?",
});

answer.text;            // "AWS spend last quarter totaled $147,830, split as..."
answer.citations;       // Array<{ type, id }>
answer.confidence;      // 0,1
answer.policy_version;  // string | null
answer.audit_event_id;  // string
```

### Citation Shape

```typescript
type Citation =
  | { type: "ledger.transaction"; id: string }
  | { type: "ledger.invoice";     id: string }
  | { type: "ledger.balance";     id: string }
  | { type: "raw.artifact";       sha256: string }
  | { type: "wiki.entity";        id: string };
```

You can fetch the underlying record from any citation:

```typescript
for (const cite of answer.citations) {
  if (cite.type === "ledger.transaction") {
    const tx = await brain.ledger.getTransaction(cite.id);
    console.log(tx.amount, tx.counterparty);
  }
}
```

### Browse the Entity Graph

```typescript
// Get a counterparty entity
const vendor = await brain.wiki.getEntity({
  tenantId: "acme",
  entityId: "cp_aws",
});

vendor.type;              // "counterparty"
vendor.name;              // "Amazon Web Services"
vendor.first_seen;        // "2023-01-14"
vendor.total_volume;      // "1,247,830 USD"
vendor.cadence;           // "monthly"
vendor.related_entities;  // [{ type, id, relationship }]

// Walk relationships
const related = await brain.wiki.getRelated({
  tenantId: "acme",
  entityId: "cp_aws",
  relationship: "paid_via",
});
```

### Common Entity Types

| Entity Type    | Description                                      |
| -------------- | ------------------------------------------------ |
| `counterparty` | Vendors, customers, employees, processors        |
| `account`      | Bank accounts, ledger accounts, on-chain wallets |
| `product`      | Products and SKUs referenced in invoices         |
| `contract`     | Contracts and agreements                         |
| `employee`     | People in the tenant's organisation              |

### Search by Semantic Similarity

```typescript
const results = await brain.wiki.search({
  tenantId: "acme",
  query: "subscription tools we use for engineering",
  limit: 10,
});

// results: array of entities with similarity scores,
// each with citations back to Ledger records
```

### Question Types the Wiki Handles Well

| Pattern                 | Example                                     |
| ----------------------- | ------------------------------------------- |
| **Identity / lookup**   | "Who is this counterparty?"                 |
| **Aggregation**         | "What is our normal monthly burn?"          |
| **History**             | "Have we paid this vendor before?"          |
| **Change detection**    | "What changed in receivables this quarter?" |
| **Forecasting context** | "What recurring charges hit next month?"    |

{% hint style="success" %}
The Wiki refuses to speculate. If a claim cannot be cited from the Ledger or Raw, it is not produced.
{% endhint %}

### Audit Hook

Every Wiki call emits an audit event. The `audit_event_id` returned in every response can be used to pull a Merkle proof later.

```typescript
const proof = await brain.audit.proof(answer.audit_event_id);
```

[**→ Audit SDK reference**](audit.md)
