# The Wiki

The Wiki is a **continuously updated structured memory per tenant**. Not a vector store with documents in it. A graph of entities, relationships, narratives, and rolling summaries, linked back to Ledger and Raw.

{% hint style="info" %}
The Wiki is what makes Brain compound. The longer it runs for a tenant, the deeper the memory and the lower the marginal cost per query.
{% endhint %}

### What Lives in the Wiki

| Element               | Examples                                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| **Entities**          | Counterparties, accounts, products, contracts, employees                  |
| **Relationships**     | "Vendor X invoices Cost Center Y", "Account A funds Subsidiary B"         |
| **Narratives**        | "Q3 receivables held flat versus Q2 despite revenue growth, driven by..." |
| **Rolling summaries** | Week-over-week, month-over-month, quarter-over-quarter snapshots          |
| **Embeddings**        | pgvector embeddings indexed for semantic retrieval                        |

### What the Wiki Answers

The Wiki is built to answer the kinds of questions only memory can answer.

| Example Question                            | Why Memory Is Required                 |
| ------------------------------------------- | -------------------------------------- |
| "Who is this counterparty?"                 | Requires accumulated entity knowledge  |
| "What is our normal monthly burn?"          | Requires rolling baselines             |
| "Have we paid this vendor before?"          | Requires historical lookups            |
| "What changed in receivables this quarter?" | Requires diff against prior periods    |
| "Is this subscription one we still use?"    | Requires usage and recurrence tracking |

### Evidence on Every Answer

The question API returns the evidence it used for each answer. Each evidence item
identifies a retrieved Ledger entity and includes an excerpt from that entity's
Wiki projection.

```typescript
const answer = await brain.wiki.question({
  tenantId: "acme",
  question: "What did we spend on AWS last quarter, by environment?",
});

// answer.question  -> submitted question
// answer.answered  -> whether a grounded or deterministic answer was produced
// answer.answer    -> fluent natural-language response
// answer.evidence  -> [{ entityType, entityId, excerpt }, ...]
// answer.model     -> model identifier
// answer.usage     -> token usage
```

{% hint style="success" %}
You do not have to trust the Wiki blindly. The response identifies the Ledger
entities that supplied the returned evidence.
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

| Time Horizon     | What Compounds                                                   |
| ---------------- | ---------------------------------------------------------------- |
| **First weeks**  | Entity resolution stabilizes; counterparty profiles emerge       |
| **First months** | Rolling baselines mature; anomaly detection becomes possible     |
| **First year**   | Year-over-year comparisons unlock; vendor history is deep        |
| **Multi-year**   | Cross-period narratives become durable; switching costs are high |

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>📥 Raw and Ledger</strong></td><td>The verified substrate underneath the Wiki.</td><td><a href="raw-and-ledger.md">raw-and-ledger.md</a></td><td></td></tr><tr><td><strong>📋 Policy</strong></td><td>How Wiki context informs policy decisions.</td><td><a href="policy-and-permissioning.md">policy-and-permissioning.md</a></td><td></td></tr><tr><td><strong>🛠️ Wiki SDK</strong></td><td>Programmatic queries.</td><td><a href="../api-reference/wiki-api.md">wiki-api.md</a></td><td></td></tr></tbody></table>
