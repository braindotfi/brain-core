---
description: What Brain knows about a tenant, where it came from, and how to query it.
---

# Memory

Brain holds, per tenant, a continuously updated record of every financial fact it has seen: transactions, balances, accounts, counterparties, obligations, invoices, contracts, on-chain transfers. You can query it as structured data or in natural language.

### Two Ways to Read It

```typescript
// Structured.
const txns = await brain.transactions.list("acme", { from: "2025-09-01" });

// Natural language.
const answer = await brain.ask("acme", "What did we spend on AWS last month?");
```

Both reach the same underlying record. Structured queries are precise and predictable. Natural-language questions are forgiving and discoverable. Use structured for code paths you'll hit often; use natural language for the questions you wouldn't have thought to filter for.

### What Goes In

Brain ingests from any source the tenant authorizes:

| Category                 | Examples                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| **Banks and processors** | Plaid, direct bank APIs, Stripe, Adyen                              |
| **On-chain**             | Wallets via Alchemy, contract event streams                         |
| **ERPs**                 | NetSuite, SAP, Dynamics                                             |
| **Accounting**           | QuickBooks, Xero                                                    |
| **Payroll**              | Gusto, Rippling, ADP                                                |
| **Documents**            | Email-attached invoices, CSV/PDF uploads                            |
| **Agent contributions**  | Transcripts, signed contracts, observations from external agents |

You connect a source once. Brain handles the rest: pulling, parsing, normalizing, indexing, keeping it current.

### Citations on Every Claim

Every answer Brain gives carries citations back to source evidence.

```typescript
const answer = await brain.ask("acme", "Which vendor did we pay the most last quarter?");

answer.text;
// "Amazon Web Services, $182,431 across 14 invoices."

answer.citations;
// [
//   { type: "transaction", id: "tx_4127" },
//   { type: "transaction", id: "tx_4128" },
//   { type: "invoice",     id: "inv_8231" },
//   ...
// ]
```

You can render those citations in your UI as clickable proof. Open one and Brain returns the underlying transaction, invoice, or document.

### What "Continuously Updated" Means

| Trigger                         | Brain's response                                          |
| ------------------------------- | --------------------------------------------------------- |
| New transaction lands at a bank | Webhook arrives; record updates within seconds            |
| Invoice paid                    | Obligation closes; counterparty's payment history updates |
| Counterparty merged             | Duplicate entities resolve; relationships rewrite         |
| New month begins                | Rolling summaries regenerate                              |

There's no batch job you wait for. The memory is current.

### What "Tenant-Isolated" Means

Each tenant has its own logical record. Cross-tenant access is impossible by construction:

| Boundary          | How                                                                 |
| ----------------- | ------------------------------------------------------------------- |
| **Storage**       | Per-tenant database partitions and Azure Blob prefixes              |
| **Encryption**    | Tenant-scoped DEKs wrapped by tenant-scoped KEKs in Azure Key Vault |
| **Authorization** | Every API call carries a tenant; cross-tenant reads return 404      |

You'll never accidentally surface one customer's data in another customer's response.

### Memory Compounds

The longer Brain runs for a tenant, the better it gets:

| Time horizon     | What improves                                                 |
| ---------------- | ------------------------------------------------------------- |
| **First days**   | Counterparty profiles emerge; basic narrative anchors form    |
| **First months** | Rolling baselines mature; anomaly detection becomes possible  |
| **First year**   | Year-over-year comparisons unlock; vendor history is deep     |
| **Multi-year**   | Cross-period narratives are durable; switching costs are real |

### Where This Lives in the Protocol

If you want to look under the hood, memory is built from three of Brain's six layers:

| Layer      | Job                                              |
| ---------- | ------------------------------------------------ |
| **Raw**    | Lossless ingestion of the original evidence      |
| **Ledger** | Deterministic structuring into immutable records |
| **Wiki**   | Continuously regenerated human-readable memory   |

[**→ Protocol: Raw and Ledger**](../protocol/raw-and-ledger.md)

### Related

| Concept                                | Page   |
| -------------------------------------- | ------ |
| The rules that govern action on memory | Policy |
| Who can read memory                    | Agents |
| Proving Brain's claims                 | Proof  |
