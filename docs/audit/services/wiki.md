# Audit: services/wiki (`@brain/wiki`)

**Audited:** 2026-05-26
**Files examined:**
- `services/wiki/src/server.ts`, `deps.ts`, `index.ts`
- `services/wiki/src/routes/annotate.ts`, `annotate.test.ts`, `entity.ts`, `search.ts`, `question.ts`, `memory.ts`, `schema.ts`
- `services/wiki/src/question/orchestrator.ts`, `orchestrator.test.ts`
- `services/wiki/src/repository/entities.ts`, `entities.test.ts`, `relations.ts`
- `services/wiki/src/pages/WikiPageService.ts`, `account.ts`, `counterparty.ts`, `obligation.ts`, `monthly-summary.ts`, `invoice.ts`, `agent.ts`, `policy.ts`, `cash-flow.ts`, `sections.ts`, `types.ts`, `proof-explanation.ts`
- `services/wiki/migrations/0001–0006`
- `services/wiki/package.json`, `vitest.integration.config.ts`
- `shared/src/contracts/IWikiMemoryService.ts`
- `services/api/src/main.ts` (lines 290–356, `buildWikiMemoryService`)
- `scripts/check-wiki-no-ledger-write.mjs`

**Commands run:**
- `pnpm --filter @brain/wiki run test` → 36 tests pass
- `pnpm --filter @brain/wiki run typecheck` → clean (no errors)
- `node scripts/check-wiki-no-ledger-write.mjs services/wiki/src` → OK
- `grep -rn "INSERT INTO ledger|UPDATE ledger" services/wiki/src/` → 0 results
- `grep -rn "ledger_" services/wiki/src/question/orchestrator.ts` → 3 SELECT-only reads
- `grep -rn "ledger_" services/wiki/src/pages/*.ts` → SELECT-only reads in all 8 generators

---

## 1. Scope

This report covers the `@brain/wiki` workspace: the HTTP surface it registers
(`/wiki/*`, `/memory/*`), the bitemporal entity/relation graph, the natural-
language Q&A orchestrator, the Phase-5 page rendering system (8 generators +
`WikiPageService`), the annotation rate-limiter, and all six migrations.

**Not in scope:** the MCP `wiki.question` and `wiki.annotate` tool wiring
(covered in `mcp/runtime.md`); cross-service identity of `IWikiMemoryService`
(covered in `runtime/boot.md`).

---

## 2. Intended Architecture

Layer 3 in the six-layer model. Dual responsibility per `Brain_MVP_Architecture.md` §3:

1. **Bitemporal entity/relation graph**. `wiki_entities` + `wiki_relations` store human-readable, temporally versioned facts whose canonical record lives in another service (post-v0.3, only `policy` and `agent` pointer types remain in the graph; financial-truth kinds moved to Ledger in migration 0003).

2. **Narrative memory + Q&A**. `WikiPageService` renders markdown pages on demand from Ledger state; `askWiki` answers natural-language questions grounded in live Ledger rows (not Wiki text). `/memory/search` uses pgvector cosine similarity over `body_embedding`.

Layer boundary invariants (per `CLAUDE.md`):
- Wiki may read Ledger tables (sanctioned cross-service read via `TenantScopedClient`).
- Wiki must **never write** Ledger tables (`check-wiki-no-ledger-write.mjs` enforces this).
- Policy and Execution never read Wiki.

---

## 3. Actual Implementation

### 3.1 Bitemporal graph (wiki_entities / wiki_relations)

Fully implemented. `insertEntity` closes the predecessor's `valid_to` atomically before inserting the new version. Confidence cap (`AGENT_CONTRIBUTED_CONFIDENCE_CEILING = 0.5`) enforced in `cappedConfidence`. Semantic search via pgvector is wired (`semanticSearch`). Lexical text search via `ILIKE attributes::text` is wired (`searchEntities`).

**Kind narrowing (migration 0003):** The `wiki_entities.kind` CHECK constraint was narrowed in migration 0003 from `{account, counterparty, transaction, obligation, policy, agent}` to `{policy, agent}` only. The migration dynamically discovers and drops the v0.1 constraint before adding the v0.3 one.

The source migration file (`0001_wiki_entities.sql`) still lists the broader set in a comment from when it was originally written. The live constraint is determined by migration 0003, not 0001.

### 3.2 Q&A orchestrator

`askWiki` is implemented end-to-end:
1. Checks Redis cache (5-minute TTL, SHA-256 dedup key over question + asOf + tenantId + model).
2. Pulls bounded Ledger rows via three parameterized SELECTs (30 transactions, 15 obligations, 15 counterparties). All reads, never writes.
3. Composes evidence context as a string of typed IDs.
4. Calls `LlmAdapter.complete` with temperature=0, 15s timeout.
5. Filters the LLM's `evidence_ids` against the retrieved set (§11.2 prompt-injection mitigation. The LLM can only cite what it was shown).
6. Caches result, emits latency + cost metrics.

**Ledger reads are sanctioned:** The orchestrator reads `ledger_transactions`, `ledger_obligations`, `ledger_counterparties` directly via `TenantScopedClient`. This is the documented cross-service read exception for the Wiki layer (CLAUDE.md §"Data-Flow Rules").

### 3.3 Page rendering (Phase 5)

`WikiPageService` registers 8 generators:
`AccountPageGenerator`, `CounterpartyPageGenerator`, `ObligationPageGenerator`,
`MonthlySummaryPageGenerator`, `InvoicePageGenerator`, `AgentPageGenerator`,
`PolicyPageGenerator`, `CashFlowPageGenerator`.

Each generator reads Ledger tables (`ledger_accounts`, `ledger_balances`,
`ledger_transactions`, `ledger_counterparties`, `ledger_obligations`,
`ledger_invoices`, `ledger_payment_intents`, `ledger_documents`) via SELECT-only
queries. None write to Ledger.

`regenerate` upserts into `wiki_pages`, including a pgvector embedding computed
by calling `EmbeddingAdapter.embed(body_md)`. The embedding is stored in
`body_embedding` (vector(1536)) for `/memory/search`.

`search` uses cosine similarity: `ORDER BY body_embedding <=> $1::vector`. 
**Gap:** `listPages`'s `q` filter uses `LOWER(body_md) LIKE $n` (lexical),
and `wiki_pages` has no full-text search index. On a large corpus this will
be a sequential scan.

### 3.4 Annotation rate-limiter

`registerAnnotate` builds a `SlidingWindowRateLimiter` once at route registration:
- Default: `RedisSlidingWindowRateLimiter`, 60 hits/hour per `(tenant_id, actor)`.
- Configurable via `WIKI_ANNOTATION_RATE_PER_HOUR` env variable or `deps.annotationRateLimiter` injection.
- Rate check fires **before any DB write** (poison-pool test verifies this).
- On limit breach: emits `wiki.annotation.rate_limited` audit event, returns 429.

### 3.5 Annotate route scope vs IWikiMemoryService.annotate

There are **two annotation concepts** with the same name:

| Surface | Target | Status |
|---------|--------|--------|
| `POST /wiki/annotate` (HTTP route) | `{policy, agent}` wiki entities and relations | **Working**. Writes to `wiki_entities`/`wiki_relations`, rate-limited |
| `IWikiMemoryService.annotate` (internal contract) | Ledger kinds (`ledger_account`, `ledger_transaction`, etc.). Write-through path | **Stubbed**. Throws `internal_server_error` unconditionally (R-16 confirmed) |

The MCP `wiki.annotate` tool calls `IWikiMemoryService.annotate` (the stub), so the MCP path always returns 500. The HTTP `POST /wiki/annotate` route is unrelated and works for `policy`/`agent` kinds.

### 3.6 No-write invariant

`check-wiki-no-ledger-write.mjs` runs against `services/wiki/src/` and exits 0. It checks:
1. No import of a Ledger write-helper (`insert*`, `update*`, `delete*`, etc.) from `@brain/ledger`.
2. No raw `INSERT INTO|UPDATE|DELETE FROM ledger_*` SQL.

Live grep confirms zero matches.

**H-14 role isolation** (`migration 0005_wiki_role.sql`): creates `brain_wiki_reader` with `SELECT` on all tables but `INSERT/UPDATE/DELETE` only on `wiki_entities`, `wiki_pages`, `wiki_relations`. This makes the no-write invariant physical at the Postgres permission level. A wiki code path attempting to write `ledger_*` would receive a Postgres permission error. **Unverified against live DB** (requires `psql` + role inspection).

---

## 4. Runtime Validation

```
$ pnpm --filter @brain/wiki run test
 ✓ src/pages/proof-explanation.test.ts (10 tests)
 ✓ src/pages/sections.test.ts (6 tests)
 ✓ src/repository/entities.test.ts (2 tests)
 ✓ src/pages/generators.test.ts (3 tests)
 ✓ src/question/orchestrator.test.ts (5 tests)
 ✓ src/routes/annotate.test.ts (2 tests)
 ✓ src/schemas.test.ts (7 tests)
 ✓ src/index.test.ts (1 test)
 Tests 36 passed (8 files)

$ pnpm --filter @brain/wiki run typecheck
(no output. Clean)

$ node scripts/check-wiki-no-ledger-write.mjs services/wiki/src
wiki-no-ledger-write guard: OK
```

**Integration tests:** `vitest.integration.config.ts` exists but `passWithNoTests: true`. Zero integration tests are present. No happy-path or error-path HTTP integration coverage for any wiki route.

**Embedding path untested:** `WikiPageService.search` and `regenerate` call `EmbeddingAdapter.embed`; tests mock the adapter. The ivfflat index at `lists=50` would require at least ~2500 vectors to be useful per Postgres docs, but this is a tuning gap, not a correctness bug.

---

## 5. Functional Status

**Mostly Working**

The bitemporal graph, annotation rate-limiter, page rendering (8 generators), and Q&A orchestrator are all implemented and type-clean. 36 unit tests pass. The `IWikiMemoryService.annotate` (Ledger write-through path) is intentionally stubbed and causes all MCP `wiki.annotate` invocations to return 500. The `/memory/search` pgvector path depends on Ledger data being populated (requires `normalizeWorker` pipeline to be operational. See R-19 in `services/raw-and-ledger.md`). Integration test coverage is zero.

---

## 6. Architectural Violations

**None found** for Wiki→Ledger write violations. The CI guard (`check-wiki-no-ledger-write.mjs`) passes cleanly. All Ledger table accesses in wiki source files are SELECT-only.

**Sanctioned cross-service reads** are correctly scoped:
- `orchestrator.ts` reads `ledger_transactions`, `ledger_obligations`, `ledger_counterparties` via `TenantScopedClient` (documented exception).
- Page generators read Ledger tables via `TenantScopedClient` under `withTenantScope` (same sanctioned pattern).

**Observation (not a violation):** `orchestrator.ts` builds a `TenantScopedClient` via `withTenantScope` passed by the route handler, but the `AskDeps.client` field is typed as `TenantScopedClient`, not `Pool`. This correctly models the single-connection pattern. The route handler at `services/wiki/src/routes/question.ts` wraps the call in `withTenantScope` before invoking `askWiki`. RLS is applied at the connection level.

---

## 7. Missing Pieces

1. **`IWikiMemoryService.annotate` write-through path**. Deferred to "refactor-4". Any MCP agent calling `wiki.annotate` gets `internal_server_error`. The HTTP `POST /wiki/annotate` route (policy/agent kinds only) is unrelated and works. (R-16, confirmed)

2. **Zero integration tests**. `vitest.integration.config.ts` exists with `passWithNoTests: true`. No happy-path or error-path coverage for `/wiki/entity/*`, `/wiki/search`, `/wiki/annotate`, `/wiki/question`, `/memory/*`. Integration coverage is a §7.1 Engineering Standards obligation.

3. **`listPages` lacks FTS index**. The `q` filter uses `LOWER(body_md) LIKE $n` with no full-text index. A corpus of 1000+ pages would produce sequential scans.

4. **`/memory/search` depends on populated embeddings**. `wiki_pages.body_embedding` is `NULL` until `regenerate` is called. On a fresh DB, `/memory/search` returns 0 results silently (the query `WHERE body_embedding IS NOT NULL` filters everything). No population job exists.

5. **`brain_wiki_reader` role application unverified**. H-14 (`migration 0005`) creates the role but live DB verification requires `psql` against a migrated instance. CI cannot confirm.

6. **ivfflat `lists=50` tuning**. Postgres IVFFlat documentation recommends `lists = rows / 1000`. At `lists=50` the index is effective only for corpora of ~50,000+ vectors. For small tenants this adds overhead with no ANN benefit. A tuning `TODO` exists in the migration comment.

7. **`wiki_entities` CHECK in migration 0001 vs 0003 mismatch**. The `0001` source file still documents the old kind set as a comment. Migration 0003 correctly narrows it at runtime, but reading 0001 in isolation is misleading. Low cosmetic impact.

---

## 8. Evidence

**Rate-limiter correctness (`annotate.test.ts:62–87`):**
```
limiter set to limit=1; first hit saturates; POST /wiki/annotate → 429
audit event wiki.annotation.rate_limited emitted with principal_id and limit
poison pool asserts DB not touched on the denied path
```

**Q&A evidence filtering (`orchestrator.test.ts:152–179`):**
```
LLM returns evidence_ids: ["tx_01HQ7K3BBBBBBBBBBBBBBBBBBBB", "tx_NOT_RETRIEVED"]
result.evidence maps to only ["tx_01HQ7K3BBBBBBBBBBBBBBBBBBBB"]. NOT_RETRIEVED filtered
```

**IWikiMemoryService.annotate stub (`services/api/src/main.ts:349–354`):**
```ts
async annotate(_ctx, _input) {
  throw brainError("internal_server_error", "wiki.annotate not yet wired in boot binary");
}
```

**wiki-no-ledger-write guard:**
```
$ node scripts/check-wiki-no-ledger-write.mjs services/wiki/src
wiki-no-ledger-write guard: OK
```

**CI guard scope (`check-wiki-no-ledger-write.mjs:27–32`):**
Checks `LEDGER_IMPORT` (write-helper symbols from `@brain/ledger`) AND
`LEDGER_SQL_WRITE` regex `(INSERT INTO|UPDATE|DELETE FROM)\s+ledger_[a-z_]+`.

**H-14 physical isolation (`migrations/0005_wiki_role.sql`):**
`GRANT INSERT, UPDATE, DELETE ON wiki_entities, wiki_pages, wiki_relations TO brain_wiki_reader;`
No write grant on any `ledger_*` table.

**FORCE RLS (`migrations/0006_force_rls.sql`):**
```sql
ALTER TABLE wiki_entities  FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_pages     FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_relations FORCE ROW LEVEL SECURITY;
```
All three wiki-owned tables covered.

**Zero integration tests:**
```
vitest.integration.config.ts:
  passWithNoTests: true,
  include: ["src/**/*.integration.test.ts"],
// No matching files exist.
```

---

## 9. Confidence Level

**High**

All source files read directly. CI guard executed against live source. Test suite passed. The 36 unit tests cover the rate-limiter gate, Q&A evidence filtering, entity bitemporal logic, section rendering, and schema validation. The main gaps (integration tests, live DB role verification) are structural absences, not analytical uncertainties.

---

## 10. Production Readiness

**Score: 7/10**

**Working correctly:**
- Bitemporal entity/relation graph with confidence ceiling
- Annotation rate-limiter (Redis-backed, env-configurable, audit-emitting)
- Q&A orchestrator (Ledger-grounded, cached, evidence-filtered)
- 8 page generators covering all declared `page_type` values
- pgvector search for `/memory/search` and `/wiki/search` (semantic path)
- FORCE RLS on all three wiki-owned tables
- H-14 Postgres write isolation via `brain_wiki_reader` role (code-verified, DB-unverified)
- No ledger writes from wiki code (CI-guarded, grep-confirmed)

**Blockers / risks:**
- **R-16 (Medium):** `IWikiMemoryService.annotate` unconditionally throws 500. All MCP `wiki.annotate` calls fail. This is a stub, not a regression, but any MCP agent expecting annotation capability is broken.
- **Zero integration tests (Medium):** No HTTP-layer integration coverage for any wiki route. A transport-layer regression (header parsing, serialization, auth hook) would go undetected until staging.
- **`/memory/search` returns empty on fresh DB**. Not a bug but an operational surprise: pages must be regenerated before search is useful. No seed job exists.
- **`listPages` `q` filter degrades at scale**. Sequential scan on `body_md ILIKE`.

**Non-blockers:**
- `brain_wiki_reader` role: code verified, live DB unverified (shared risk with all RLS claims).
- ivfflat tuning is a follow-up, not a correctness issue.

---

## 11. Refactor Priority

**Medium**

Two items warrant targeted attention before production:

1. **Add integration tests** (Medium priority). `vitest.integration.config.ts` exists, the config is in place, no `.integration.test.ts` files have been written. Happy path + 401 + 429 for `/wiki/annotate`, `/wiki/question`, and `/memory/regenerate` would close the gap. Required by §7.1 of Engineering Standards.

2. **Wire `IWikiMemoryService.annotate`** (Medium priority, deferred "refactor-4"). The HTTP `POST /wiki/annotate` route for wiki-resident `{policy, agent}` kinds works; the MCP write-through path for Ledger kinds is the stub. Either wire it or document that MCP agents cannot annotate Ledger entities in v0.3.

The architectural invariants (no Ledger writes, correct rate-limiting, bitemporal correctness) are sound. The existing implementation is coherent and clean. Refactoring should be additive. Tests and the missing annotate write-through. Not corrective.
