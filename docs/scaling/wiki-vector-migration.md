# Wiki vector store. Scaling migration plan

Planning doc (no implementation). Wiki embeddings currently share the primary
Postgres with tenant data; that hits a ceiling. This plans the move before it is
urgent.

## Current state

- **pgvector** extension on the **primary** Postgres (Azure Database for
  PostgreSQL Flexible Server).
- 1536-dim embeddings (OpenAI `text-embedding-3-small`) on `wiki_*` tables.
- ANN index (HNSW/IVFFlat) co-located with OLTP tenant data. Embedding queries
  compete with transactional load for the same CPU/IO/buffer cache.

## Trigger metrics (move when either crosses)

- `/wiki/question` p99 latency > **X ms** sustained.
  TODO(brain-hardening): set X from the current SLO (suggest 800 ms).
- Embeddings index size > **Y GB** (memory pressure on the primary).
  TODO(brain-hardening): set Y from instance memory (suggest ~25% of RAM).
- Embedding-query share of primary CPU > a set threshold.

## Options compared

| Option                             | Pros                                                                | Cons                                                               |
| ---------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **(a) pgvector on a read replica** | Smallest change; same SQL/driver; reuses RLS + tenant model; cheap. | Replica lag on fresh embeddings; still pgvector's index ceiling.   |
| **(b) Qdrant on Azure**            | Purpose-built ANN; horizontal scale; payload filtering for tenant.  | New infra + ops; must re-implement tenant isolation in the filter. |
| **(c) Pinecone (managed)**         | Zero ops; scales transparently.                                     | Third-party data residency; cost at scale; vendor lock-in.         |

**Recommendation:** start with **(a)** (read replica) when the trigger first
fires. Lowest risk, preserves RLS. And evaluate **(b) Qdrant** if ANN
throughput on the replica still saturates.

## Migration plan (provider-agnostic)

1. **Dual-write window:** on every Wiki page (re)generation, write the embedding
   to both the current store and the new store. Reads stay on the old store.
2. **Backfill:** batch re-embed existing `wiki_*` rows into the new store
   (idempotent, resumable, tenant-by-tenant). Verify counts per tenant.
3. **Shadow reads:** route a fraction of `/wiki/question` reads to the new store
   and compare result sets + latency (no user-visible change).
4. **Cutover:** flip reads to the new store behind a config flag once parity +
   latency targets hold.
5. **Rollback:** the flag flips back to the old store instantly; dual-write keeps
   both warm until the new store is trusted, then stop writing the old one.

## Cost estimate (design-partner scale)

10 tenants × N pages × 1536 dims (float32 ≈ 6 KB/vector).
TODO(brain-hardening): fill N from current page counts and price each option
(replica instance vs Qdrant node vs Pinecone pod) once N is known.

## Tenant isolation note

Whatever store is chosen MUST preserve §1 tenant isolation: pgvector inherits
Postgres RLS; Qdrant/Pinecone require an enforced tenant filter on every query
(payload/namespace), treated as a hard correctness requirement, not best-effort.
