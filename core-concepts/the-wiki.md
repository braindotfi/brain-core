# The Wiki

The Wiki is a **continuously updated structured memory per tenant**. Not a vector store with documents in it. A graph of entities, relationships, narratives, and rolling summaries, linked back to Ledger and Raw.

{% hint style="info" %}
The Wiki is what makes Brain compound. The longer it runs for a tenant, the deeper the memory and the lower the marginal cost per query.
{% endhint %}

### What Lives in the Wiki

<table><thead><tr><th width="200">Element</th><th>Examples</th></tr></thead><tbody><tr><td><strong>Entities</strong></td><td>Counterparties, accounts, products, contracts, employees</td></tr><tr><td><strong>Relationships</strong></td><td>"Vendor X invoices Cost Center Y", "Account A funds Subsidiary B"</td></tr><tr><td><strong>Narratives</strong></td><td>"Q3 receivables held flat versus Q2 despite revenue growth, driven by..."</td></tr><tr><td><strong>Rolling summaries</strong></td><td>Week-over-week, month-over-month, quarter-over-quarter snapshots</td></tr><tr><td><strong>Embeddings</strong></td><td>pgvector embeddings indexed for semantic retrieval</td></tr></tbody></table>

### What the Wiki Answers

The Wiki is built to answer the kinds of questions only memory can answer.

| Example Question                            | Why Memory Is Required                 |
| ------------------------------------------- | -------------------------------------- |
| "Who is this counterparty?"                 | Requires accumulated entity knowledge  |
| "What is our normal monthly burn?"          | Requires rolling baselines             |
| "Have we paid this vendor before?"          | Requires historical lookups            |
| "What changed in receivables this quarter?" | Requires diff against prior periods    |
| "Is this subscription one we still use?"    | Requires usage and recurrence tracking |

### Citations on Every Answer

Every answer carries citations into the Ledger and Raw. Any claim is traceable back to source evidence.

```typescript
const answer = await brain.wiki.question({
  tenantId: "acme",
  question: "What did we spend on AWS last quarter, by environment?"
});

// answer.text         → fluent natural-language response
// answer.citations[]  → [{ ledger_id, raw_refs: [...] }, ...]
// answer.audit_event_id → the audit event under which this query was logged
```

{% hint style="success" %}
You never have to trust the Wiki blindly. Every claim links back to the Ledger records and Raw artifacts that produced it.
{% endhint %}

### How the Wiki Updates

The Wiki updates **incrementally** as new Ledger records arrive.

| Trigger                   | Wiki Action                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| New transaction in Ledger | Update counterparty profile, refresh rolling balance, re-embed narrative |
| Counterparty merge        | Resolve duplicate entities, rewrite relationship edges                   |
| Invoice paid              | Close the matching obligation; update vendor history                     |
| Period boundary           | Generate rolling summary; index for retrieval                            |

### Why Not Just a Vector Store

Vector stores retrieve documents. The Wiki retrieves a graph of verified entities with citations.

| Vector store                        | Wiki                                    |
| ----------------------------------- | --------------------------------------- |
| Returns chunks of documents         | Returns entities and relationships      |
| No native citations to source       | Every node links to Ledger and Raw      |
| Updates by re-embedding             | Updates incrementally as Ledger changes |
| No notion of correction             | Supersession propagates from Ledger     |
| Reasoning hallucinated on retrieval | Reasoning bounded by structured facts   |

### Compounding Effect

Brain's Wiki gets cheaper to query and richer to read the longer it runs.

<table><thead><tr><th width="200">Time Horizon</th><th>What Compounds</th></tr></thead><tbody><tr><td><strong>First weeks</strong></td><td>Entity resolution stabilizes; counterparty profiles emerge</td></tr><tr><td><strong>First months</strong></td><td>Rolling baselines mature; anomaly detection becomes possible</td></tr><tr><td><strong>First year</strong></td><td>Year-over-year comparisons unlock; vendor history is deep</td></tr><tr><td><strong>Multi-year</strong></td><td>Cross-period narratives become durable; switching costs are high</td></tr></tbody></table>
