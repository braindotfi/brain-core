---
hidden: true
---

# Why Brain

AI agents are now capable of executing multi-step economic tasks: paying invoices, managing cash, collecting receivables, rebalancing treasuries, and filing reports. At the same time, financial activity is more fragmented than ever. A single tenant generates data and records across a dozen banks, processors, ERPs, accounting tools, and on-chain wallets.

These two trends collide at a missing layer: agents need a financial substrate they can read from and write to with strong guarantees. Structured truth, persistent memory, enforceable policy, verifiable audit.

### The Three Planes That Don't Naturally Interoperate

Financial activity today is split across three planes that were never designed to talk to each other.

<table><thead><tr><th width="200">Plane</th><th>Examples</th></tr></thead><tbody><tr><td><strong>Evidence plane</strong></td><td>Bank feeds, statements, invoices, receipts, emails, ERP records, payroll runs, processor settlements, on-chain transfers</td></tr><tr><td><strong>Execution plane</strong></td><td>ACH, wires, cards, RTP, stablecoins, programmable wallets, payment processors, treasury platforms</td></tr><tr><td><strong>Reasoning plane</strong></td><td>LLMs and agents that can plan, but have no durable, verified context about a tenant's financial state</td></tr></tbody></table>

{% hint style="warning" %}
Every fintech application today reinvents the integration between these planes from scratch. The evidence is partial. Execution is unsafe. Reasoning is hallucinated.

Agents either lack the data to act intelligently or, worse, act on data they cannot verify and cannot prove they verified.
{% endhint %}

### Why Existing Infrastructure Does Not Solve It

| Category                  | What It Provides         | What It Lacks                                                              |
| ------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| **Banks and neobanks**    | Balances and rail access | Structured memory, programmable policy surface                             |
| **Accounting tools**      | Structured data          | Stop at the report; cannot act                                             |
| **Personal finance apps** | Aggregation              | Cannot act                                                                 |
| **Generic AI assistants** | Reasoning                | Cannot trust inputs, cannot prove outputs                                  |
| **Agent marketplaces**    | Agents                   | Agents without a shared verified substrate are just LLMs in front of silos |

The missing primitive is not another agent or another bank. It is the protocol the agents read from, write to, and prove against.

### What Brain Provides

<table data-view="cards"><thead><tr><th></th><th></th></tr></thead><tbody><tr><td><strong>🧾 Structured truth</strong></td><td>Deterministic Ledger with provenance back to raw evidence on every record.</td></tr><tr><td><strong>🧠 Persistent memory</strong></td><td>A Wiki that compounds over time, linked back to Ledger and Raw.</td></tr><tr><td><strong>📋 Enforceable policy</strong></td><td>Plain-English rules compiled to deterministic guards, signed by the tenant via EIP-712.</td></tr><tr><td><strong>🛡️ Verifiable audit</strong></td><td>Per-tenant Merkle tree, batched and anchored on Base L2 every ten minutes.</td></tr></tbody></table>

### A Concrete Contrast

Consider a tenant with $7,800 in invoices to pay across four vendors.

| Without Brain                              | With Brain                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Agent reads partial data from one source   | Agent reads verified Ledger with provenance to every artifact                                 |
| Hardcoded if-statements approximate policy | Tenant-signed policy evaluated as a deterministic guard                                       |
| Action executes with no audit beyond logs  | Every step (proposal, decision, approval, execution, settlement) is hashed into a Merkle tree |
| Disputes become forensics                  | Counterparties verify a Merkle proof against an anchored root                                 |
| Trust must be re-earned per integration    | Reputation accumulates on-chain via ERC-8004                                                  |

### What this Enables

Brain unlocks the autonomous financial economy by giving agents what they have always lacked: a substrate that is **non-custodial, programmable, verifiable, and shared**.

Six composable protocol layers, one API, no custody. Evidence becomes structure, structure becomes memory, memory becomes intelligence, and intelligence becomes execution, all bounded by tenant policy and proven by a tamper-evident audit anchored on-chain.
