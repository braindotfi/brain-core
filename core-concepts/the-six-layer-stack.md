# The Six-Layer Stack

Brain is a layered protocol. Information flows up; control flows down.

```
Raw → Ledger → Wiki → Policy → Agent → Audit
```

Each tenant has its own logical instance of every layer, with hard isolation at the database, KMS, and policy boundaries. Off-chain state lives in Postgres with pgvector and S3-backed raw artifacts. On-chain commitments and smart-account execution live on Base L2.

### The Six Layers at a Glance

<table data-view="cards"><thead><tr><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>1️⃣ Raw</strong></td><td>Lossless ingestion of evidence from any authorized source.</td><td><a href="raw-and-ledger.md">raw-and-ledger.md</a></td></tr><tr><td><strong>2️⃣ Ledger</strong></td><td>Deterministic structuring into immutable records with provenance.</td><td><a href="raw-and-ledger.md">raw-and-ledger.md</a></td></tr><tr><td><strong>3️⃣ Wiki</strong></td><td>Continuously updated memory graph per tenant.</td><td><a href="the-wiki.md">the-wiki.md</a></td></tr><tr><td><strong>4️⃣ Policy</strong></td><td>Plain-English rules compiled to deterministic guards.</td><td><a href="policy-and-permissioning.md">policy-and-permissioning.md</a></td></tr><tr><td><strong>5️⃣ Agent</strong></td><td>Internal and external agents executing within policy.</td><td><a href="agents.md">agents.md</a></td></tr><tr><td><strong>6️⃣ Audit</strong></td><td>Per-tenant Merkle tree anchored on Base L2.</td><td><a href="audit-and-proof.md">audit-and-proof.md</a></td></tr></tbody></table>

### Why Six Layers, In This Order

The stack is not a stylistic choice. Each layer enforces a property that the layer above it requires.

| Layer      | What It Enforces                               | Why It Matters                                                             |
| ---------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| **Raw**    | Lossless, replayable storage                   | Higher layers can be rebuilt deterministically if extraction logic changes |
| **Ledger** | Deterministic structure with provenance        | Reasoning never reinterprets raw documents on the fly                      |
| **Wiki**   | Continuously refreshed memory linked to Ledger | Answers compound over time; citations are always traceable                 |
| **Policy** | Tenant-signed deterministic rules              | No agent action runs unchecked                                             |
| **Agent**  | Scoped, attestable execution                   | Internal and external agents share one verified substrate                  |
| **Audit**  | Hash-chained, Merkle-anchored events           | History cannot be silently rewritten                                       |

{% hint style="success" %}
This is the same separation that exists in any serious system between the database and the cache: structure first, reasoning second, memory bound to citations.
{% endhint %}

### Information Flow

Information flows **up**. Each layer enriches the one below.

```
Source webhook
   ↓
[ Raw ]            artifact stored, content-addressed by SHA-256
   ↓
[ Ledger ]         deterministic extractor produces structured records
   ↓
[ Wiki ]           entity resolution, narrative summarization, embeddings
   ↓
[ Policy ]         action evaluated against active policy version
   ↓
[ Agent ]          execution dispatched to off-chain rail or on-chain account
   ↓
[ Audit ]          every step hashed, Merkle root anchored on Base
```

### Control Flow

Control flows **down**. Higher layers gate lower ones.

| Layer Above | Gates                    | Layer Below                    |
| ----------- | ------------------------ | ------------------------------ |
| **Audit**   | requires hash links from | every other layer              |
| **Agent**   | requires verdict from    | Policy                         |
| **Policy**  | reads from               | Wiki and Ledger                |
| **Wiki**    | rebuilds from            | Ledger                         |
| **Ledger**  | replays from             | Raw                            |
| **Raw**     | sources from             | the tenant's connected systems |

### Off-Chain and On-Chain Split

Most logic is off-chain by design. On-chain contracts exist to anchor state, register identity, validate ERC-4337 UserOps, and route agent execution.

<table><thead><tr><th width="250">Tier</th><th>What Lives Here</th></tr></thead><tbody><tr><td><strong>Off-chain</strong></td><td>Raw artifacts (S3), Ledger records (Postgres), Wiki graph (Postgres + pgvector), Policy compiler, Agent runtime</td></tr><tr><td><strong>On-chain (Base L2)</strong></td><td><code>BrainAuditAnchor</code>, <code>BrainPolicyRegistry</code>, <code>BrainSmartAccount</code>, <code>BrainMCPAgentRegistry</code></td></tr></tbody></table>
