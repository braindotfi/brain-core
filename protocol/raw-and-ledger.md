# Raw and Ledger

The bottom two layers of the stack do one job together: turn messy financial evidence into deterministic, structured records with provenance back to source.

### Raw Layer

The Raw Layer ingests financial evidence verbatim from authorized sources.

#### Sources

| Category                      | Examples                                              |
| ----------------------------- | ----------------------------------------------------- |
| **Banks and processors**      | Plaid, direct bank APIs, Stripe, Adyen                |
| **Custodians and brokerages** | Brokerage feeds, custodian APIs                       |
| **On-chain**                  | Wallets via Alchemy, contract event streams           |
| **ERPs**                      | NetSuite, SAP, Dynamics                               |
| **Accounting platforms**      | QuickBooks, Xero                                      |
| **Payroll**                   | Major payroll providers                               |
| **Documents**                 | Email-attached invoices and receipts, CSV/PDF uploads |

#### Storage Rules

Artifacts are content-addressed by SHA-256 and stored under tenant-prefixed Azure
Blob paths. Source credentials, not every raw artifact, are encrypted at the
application boundary with the global AES-256-GCM source-credential key from
`shared/src/crypto/credential-key-provider.ts`.

| Property       | Value                                                               |
| -------------- | ------------------------------------------------------------------- |
| **Identifier** | `sha256:<hex>` over canonical bytes                                 |
| **Encryption** | Source credentials use AES-256-GCM with a global key today          |
| **Storage**    | Azure Blob with versioning, tenant prefixes, and lifecycle policies |
| **Retention**  | Per-tenant, configurable per source                                 |

{% hint style="info" %}
**Nothing is interpreted at this layer.** The Raw Layer's only job is to be a lossless, replayable record. If the extraction logic changes, every higher layer can be rebuilt deterministically from Raw.
{% endhint %}

### Ledger Layer

The Ledger Layer normalizes raw evidence into standard linkable objects.

#### Record Types

| Type                       | Purpose                                     |
| -------------------------- | ------------------------------------------- |
| `transactions`             | Money movements between accounts            |
| `balances`                 | Point-in-time and rolling balances          |
| `accounts`                 | Tenant-side and counterparty accounts       |
| `counterparties`           | Vendors, customers, employees               |
| `invoices`                 | Billed amounts, due dates, line items       |
| `obligations`              | Subscriptions, recurring charges, contracts |
| `cash_flows`               | Aggregations and forecasts                  |
| `assets` and `liabilities` | Holdings and debts                          |
| `permissions`              | Authorizations affecting the Ledger         |
| `events`                   | Lifecycle events tied to records            |

#### Post-Projection Agent Routing

For uploaded financial documents, projection into Ledger also emits a single
artifact-level `ledger.upload.projected` event. The event is not per row. It
summarizes what the artifact created, including transaction, receivable,
obligation, account, and counterparty counts.

The API worker routes that event to the internal-agent fleet through the normal
agent run machinery. Collections can respond to receivables, Cash Forecasting
and Treasury can respond to transactions, Vendor Risk can respond to new
counterparties, and Reconciliation can respond when uploaded transactions and
tenant receivables coexist. The run remains propose-only: it may create
reviewable proposals or informational agent actions, but it does not execute
payments or bypass Policy.

Each upload-triggered run is idempotent by tenant, raw artifact id, and agent.
Reprojecting the same artifact can refresh Ledger state, but it does not spawn
duplicate agent proposals.

#### Provenance on Every Record

Every Ledger record carries:

| Field               | What It Contains                             |
| ------------------- | -------------------------------------------- |
| `raw_refs`          | The Raw artifact hashes that produced it     |
| `extractor_version` | The deterministic extractor that produced it |
| `confidence`        | A calibrated score from 0 to 1               |
| `supersedes`        | Optional pointer to the record this corrects |

#### Immutability

Records are immutable and append-only. Corrections are written as superseding records that reference what they correct.

```
record_v1: { id: "tx_001", amount: 1234.56, supersedes: null }
record_v2: { id: "tx_002", amount: 1234.65, supersedes: "tx_001" }
```

The history is preserved. Any reader can replay the chain to see how the value evolved.

### Why Ledger Sits Between Raw and Wiki

LLMs are excellent at language and pattern recognition and unreliable at arithmetic, deduplication, and reconciliation.

| Concern                                   | Right Place                        |
| ----------------------------------------- | ---------------------------------- |
| Arithmetic, deduplication, reconciliation | Ledger (deterministic)             |
| Fluent reasoning, narrative answers       | Wiki (LLM-driven, citation-backed) |

The Wiki is the place for fluent reasoning, not the source of financial truth. Ledger enforces a deterministic, machine-verifiable structure first, so Wiki always reasons over verified facts rather than reinterpreting raw documents on every query.

{% hint style="success" %}
This is the same separation that exists in any serious system between the database and the cache. Brain's Ledger is the database; the Wiki is the reasoning surface that points back to it.
{% endhint %}

### What's Next

<table data-view="cards"><thead><tr><th></th><th></th><th data-type="content-ref"></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>The Wiki</strong></td><td>The memory graph that reasons over the Ledger.</td><td><a href="the-wiki.md">the-wiki.md</a></td><td></td></tr><tr><td><strong>Audit and Proof</strong></td><td>How every Ledger change gets a verifiable history.</td><td><a href="audit-and-proof.md">audit-and-proof.md</a></td><td></td></tr><tr><td><strong>Sources API</strong></td><td>Connect a source through the API.</td><td><a href="../api-reference/sources-api.md">sources-api.md</a></td><td></td></tr></tbody></table>
