# The Wiki layer vs. RAG and graph

### What it is

The Wiki layer is the contextual knowledge surface in Brain's stack. It sits between the Ledger (canonical state) and the Agent (execution), and gives agents the meaning they need to act intelligently on financial data.

Think of it as Wikipedia for an autonomous financial system, except every article cites a primary source in the Ledger or Raw layer.

### What it does

The Wiki layer handles three jobs that legacy memory systems split across separate tools:

1. **Entity resolution.** "Acme Corp," "ACME Corporation," and the LEI on the wire confirmation are the same thing. Wiki knows that.
2. **Relationship modeling.** Counterparty exposures, fund flows, ownership structures, vendor hierarchies. Stored explicitly, queryable.
3. **Narrative context.** Why a transaction happened, what a counterparty does, what risk class an asset falls into. Stored as semantic content, retrievable in natural language.

Every fact in Wiki points back to verifiable evidence in Raw or Ledger. If the source moves, Wiki updates. If sources conflict, Ledger wins.

### Comparison with RAG and graph

Most memory systems use one of two tools.

**RAG** (Retrieval Augmented Generation) stores text chunks as vector embeddings and retrieves what looks similar at query time. It is fast, easy to set up, and useful for unstructured Q\&A. It has no entity identity, no relationships, and no notion of truth. Two strings that mean the same thing are unrelated to it. RAG tells you what it has read, not what it is.

**Graph** systems (knowledge graphs, property graphs) store entities and relationships explicitly. They support multi-hop traversal and structural reasoning. Strong on relationship questions. Weak on unstructured semantic content. Brittle when reality does not fit the schema. A standalone graph floats free of any system of record.

**Wiki** does both, anchored.

<table><thead><tr><th width="350">Capability</th><th>Wiki</th><th>RAG</th><th>Graph</th></tr></thead><tbody><tr><td>Semantic retrieval</td><td><strong>Yes</strong></td><td>Yes</td><td>Limited</td></tr><tr><td>Entity resolution</td><td><strong>Native</strong></td><td>No</td><td>Manual</td></tr><tr><td>Relationship traversal</td><td><strong>Yes</strong></td><td>No</td><td>Yes</td></tr><tr><td>Anchored to system of record</td><td><strong>Yes</strong></td><td>No</td><td>No</td></tr><tr><td>Provenance per fact</td><td><strong>Yes</strong></td><td>No</td><td>No</td></tr><tr><td>Conflict arbitration</td><td><strong>Ledger wins</strong></td><td>None</td><td>None</td></tr><tr><td>Suitable for autonomous money movement</td><td><strong>Yes</strong></td><td>No</td><td>No</td></tr></tbody></table>

### Why this matters

When an agent is reasoning about money, "probably true" is not enough. A treasury agent that thinks the company has $4.2M in operating cash needs to be right, not approximately right. A lending agent applying a credit policy needs to know exactly which counterparty it is dealing with, not a fuzzy match.

RAG and graphs are useful tools, but they are retrieval systems, not systems of record. They tell agents what was said. Wiki tells agents what is.

The shorthand:

* RAG sounds right
* Graph connects right
* Wiki _is_ right

### How Wiki fits in Brain

Wiki is one of six layers in the Brain stack:

* **Raw** ingests signals
* **Ledger** maintains canonical state
* **Wiki** provides semantic context, grounded in Ledger
* **Policy** defines what agents are allowed to do
* **Agent** executes within policy, using Wiki to understand context
* **Audit** records every action with cryptographic provenance

Wiki is what makes Brain agents knowledgeable. Ledger is what makes them correct. Policy is what makes them safe. Audit is what makes them accountable. Together, they are what makes autonomous financial action trustworthy.
