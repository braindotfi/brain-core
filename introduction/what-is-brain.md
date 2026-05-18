---
hidden: true
---

# What is Brain

**Brain is a financial intelligence protocol in a single API.**

It turns financial activity into memory, memory into intelligence, and intelligence into execution. AI agents can understand, reason about, and act on financial activity without Brain ever holding customer funds.

{% hint style="info" %}
Brain is non-custodial by design. Money flows directly between the tenant's accounts and counterparties on the tenant's chosen rails. Brain is the brain on top of the rails that the tenant already uses.
{% endhint %}

### The Simple Version

A tenant generates records of financial activity across many systems: bank statements, invoices, on-chain wallet transfers, ERP entries, payroll runs, and processor settlements. Today, every fintech application has to rebuild the connection between that data, the rails that move money, and the intelligence that decides what should happen next.

Brain is the missing layer between them.

It reads from every source the tenant authorizes, structures the data into a verified ledger and a queryable memory, evaluates every proposed action against policy the tenant defined in plain English, executes through the rails the tenant already uses, and emits a tamper-evident audit trail that any counterparty can verify.

### The Technical Version

Brain is a layered protocol. Information flows up; control flows down.

```
Raw → Ledger → Wiki → Policy → Agent → Audit
```

<table><thead><tr><th width="200">Layer</th><th>Job</th></tr></thead><tbody><tr><td><strong>Raw</strong></td><td>Lossless ingestion from any authorized source</td></tr><tr><td><strong>Ledger</strong></td><td>Deterministic structuring into immutable records</td></tr><tr><td><strong>Wiki</strong></td><td>Continuously updated memory graph per tenant</td></tr><tr><td><strong>Policy</strong></td><td>Plain-English rules compiled to deterministic guards</td></tr><tr><td><strong>Agent</strong></td><td>Internal and third-party agents executing within policy</td></tr><tr><td><strong>Audit</strong></td><td>Per-tenant Merkle tree anchored on Base L2</td></tr></tbody></table>

[**→ Full architecture**](/broken/pages/MAvfDj3EXySswqRZSdKE)

### What Brain is Not

* **❌ A bank:**  Brain holds neither funds nor rail access. The tenant keeps both.
* **❌ A custodian:**  Cryptographic keys for a tenant's smart account belong to the tenant. Brain co-signs against policy; it does not own custody.
* **❌ An accounting tool:**  Brain produces reports, but it also enforces policy and executes actions, with audit, on the tenant's behalf.
* **❌ An agent marketplace:**  Agent marketplaces sell agents. Brain is what those agents read from, write to, and prove against.
* **❌ An AI assistant:**  Generic assistants reason but cannot trust their inputs or prove their outputs. Brain reasons over a verified Ledger and emits a tamper-evident Audit trail.

### What Brain Is

A protocol with five non-negotiable properties.

<table><thead><tr><th width="200">Property</th><th>What It Means in Practice</th></tr></thead><tbody><tr><td><strong>Non-custodial</strong></td><td>Brain never takes custody of customer funds</td></tr><tr><td><strong>Tenant-isolated</strong></td><td>Each tenant has dedicated logical partitions and DEKs wrapped by tenant-scoped KEKs in AWS KMS</td></tr><tr><td><strong>Verifiable</strong></td><td>Every claim, decision, and action carries provenance back to source evidence and policy version</td></tr><tr><td><strong>Programmable</strong></td><td>Plain-English policy compiles to a deterministic guard evaluated on every action</td></tr><tr><td><strong>Composable</strong></td><td>The API is the agent surface; humans, internal agents, and external agents share one interface</td></tr></tbody></table>

### How Brain Compounds

Brain compounds along three reinforcing axes.

<table><thead><tr><th width="200">Axis</th><th>What Compounds</th></tr></thead><tbody><tr><td><strong>Memory</strong></td><td>The longer Brain runs for a tenant, the deeper the Wiki and the higher the marginal cost to leave</td></tr><tr><td><strong>Agents</strong></td><td>As more third-party agents register, every tenant gains more capabilities without Brain building them</td></tr><tr><td><strong>Audit</strong></td><td>As more counterparties accept Brain audit proofs, every party benefits from cheaper, faster verification</td></tr></tbody></table>
