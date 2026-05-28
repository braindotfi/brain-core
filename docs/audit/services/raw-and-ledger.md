# Audit: Services — Raw Ingestion & Ledger (`services/raw`, `services/ledger`)

**Audited:** 2026-05-26
**Files examined:**
- `services/raw/src/services/ingest.ts`
- `services/raw/src/routes/ingest.ts`
- `services/raw/src/routes/webhook.ts`
- `services/raw/src/adapters/plaid.ts`, `stubs.ts`, `registry.ts`, `types.ts`, `upload.ts`
- `services/raw/src/repository/artifacts.ts`, `parsed.ts`
- `services/raw/src/sources/SourceService.ts`, `PostgresSourceRepository.ts`, `connectors.ts`, `types.ts`
- `services/raw/src/deps.ts`, `index.ts`, `server.ts`
- `services/raw/migrations/0001–0006_*.sql` (7 files; 2 named 0004)
- `services/raw/package.json`
- `services/ledger/src/service/LedgerService.ts`, `writes.ts`
- `services/ledger/src/workers/normalizeWorker.ts`
- `services/ledger/src/extractors/plaid.ts`
- `services/ledger/src/routes/index.ts`
- `services/ledger/src/reconciliation/ReconciliationService.ts` + 7 matcher files
- `services/ledger/src/repository/artifacts.ts` (referenced), full `repository/` tree
- `services/ledger/src/cash_flows/aggregate.ts`
- `services/ledger/migrations/0001–0020_*.sql` (20 files)
- `services/api/src/main.ts` lines 643–660 (SourceService wiring), 861 (credential resolution)

**Commands run:**
- `pnpm --filter @brain/raw run test` → 63 tests, 11 files — all pass
- `pnpm --filter @brain/ledger run test` → 148 tests, 12 files — all pass
- `grep -rn "from 'plaid'" services/raw/src/` → no results (dead dep confirmed)
- `grep -rn "INSERT.*raw_parsed" services/` → zero TS results (no writer to raw_parsed)
- Static code traces for normalizeWorker poll, cross-tenant RLS, migration ordering

---

## 1. Scope

What this report covers:
- `services/raw` (`@brain/raw`) — artifact ingestion (blob + DB), webhook fan-out, source connection lifecycle, credential encryption
- `services/ledger` (`@brain/ledger`) — Ledger entity reads/writes, the normalizeWorker, the raw→ledger extraction pipeline, the ReconciliationService
- The cross-service boundary between them: `raw_parsed` table ownership, the normalizeWorker cross-tenant poll

What this report does NOT cover:
- MCP route `/ledger/*` tool invocations (covered in `mcp/runtime.md`)
- ReconciliationService scheduling (BullMQ wiring — covered in `queues/` and `orchestration/`)
- Blob storage adapter internals (covered in `integrations/`)
- Payment-intent state machine (covered in `services/execution.md`)

---

## 2. Intended Architecture

Per `Brain_MVP_Architecture.md §3 Layer 1` (Raw) and `§3 Layer 2` (Ledger):

- **Raw** is an immutable, content-addressed artifact store. Bytes in → sha256 → blob write → `raw_artifacts` row. Dedup by `(tenant_id, sha256)` UNIQUE constraint. Source adapters fan webhook payloads into artifacts.
- **Ledger** is the structured financial graph (accounts, transactions, counterparties, obligations, invoices, documents, balances, reconciliation matches). It never touches the blob layer.
- The **normalize pipeline** bridges them: a parser reads a `raw_artifacts` blob → writes a typed representation to `raw_parsed` → `normalizeWorker` polls `raw_parsed` → calls `LedgerService.normalizeFromRaw` → Ledger entities are upserted.
- Source credentials (Plaid `access_token`, Stripe `api_key`) are AES-256-GCM encrypted at rest in `raw_sources`.

---

## 3. Actual Implementation

### 3.1 Raw — ingestion paths

Two ingestion entry points, both through `ingestOne`:

| Path | Handler | Auth |
|------|---------|------|
| `POST /raw/ingest` (multipart) | `handleMultipart` | Bearer JWT, scope `raw:write` |
| `POST /raw/ingest` (JSON + URL) | `handleJson` | Bearer JWT, scope `raw:write` |
| `POST /raw/webhooks/:provider` | `registerWebhook` | Skips JWT; HMAC verification |

`ingestOne` (`services/raw/src/services/ingest.ts`):
1. sha256 hash the body.
2. `blob.put(path, body, { immutable: true })`.
3. `withTenantScope → insertOrReuseArtifact` — `ON CONFLICT (tenant_id, sha256) DO UPDATE SET source_ref = raw_artifacts.source_ref`. Returns existing row if already seen; `deduplicated` flag is set when `row.id !== requested_id`.
4. Audit emit (`raw.ingest.new` or `raw.ingest.deduplicated`).

The JSON URL path calls `fetchPublicHttps` from `@brain/shared` — SSRF-mitigated (HTTPS-only, public IP validation per hop, 50 MB cap, credential drop on redirect).

**Webhook handling**: Only Plaid is implemented. Plaid signature verified via `verifyPlaidWebhook` from `@brain/shared`. Body is kept as raw `Buffer` for the HMAC check. Five other adapters (`stripe`, `netsuite`, `email`, `chain_evm`, `agent_contributed`) are registered for `/raw/ingest` uploads but their `handleWebhook` either throws 501 or is undefined. The webhook route correctly rejects unimplemented providers with 501.

**Webhook dedup** (§5.2): sha256 of the raw body is used as a Redis idempotency key (`webhook:{provider}:{hash}`). On replay the route returns 202 immediately. On processing failure `releaseWebhook` frees the key so the provider's next retry is accepted.

### 3.2 Raw — source connections and credential encryption

`SourceService` (`services/raw/src/sources/SourceService.ts`) manages the `/v1/sources/*` lifecycle. In the production boot (`services/api/src/main.ts:649–658`):

```ts
const postgresSourceRepo = new PostgresSourceRepository({
  pool,
  credentialKey: ...,
  credentialKeyId: ...,
});
const sourceService = new SourceService(postgresSourceRepo, postgresSourceRepo);
```

`InMemorySourceRepository` is test-only. `PostgresSourceRepository` encrypts credentials for `plaid` and `stripe` source types using `encryptCredentials` / `decryptCredentials` from `@brain/shared` (AES-256-GCM). Other source types store `NULL` in `encrypted_credentials`. `external_account_ids` (GIN-indexed) enables reverse lookup: "which source owns this Plaid `account_id`?" used by the execution rail.

**Plaid connector validation** (`services/raw/src/sources/connectors.ts:plaidConnector`): checks that `access_token` is a non-empty string. Does not probe the live Plaid API. Comment documents "follow-up wires balance-get probe." A bad token is accepted at connect time and fails later at sync.

### 3.3 Raw — adapter registry

Seven adapters registered:

| `source_type` | Webhook handler | Status |
|---|---|---|
| `upload` | None (direct POST only) | Concrete |
| `plaid` | `PlaidAdapter.handleWebhook` | Concrete (webhook only; `transactions/sync` is stage-3) |
| `stripe` | 501 stub | Stub |
| `erp_netsuite` | 501 stub | Stub |
| `email` | 501 stub | Stub |
| `chain_evm` | 501 stub | Stub |
| `agent_contributed` | None | Concrete (upload only) |

`PlaidAdapter.handleWebhook` stores the full raw JSON body as one artifact per webhook delivery. It does not call `transactions/sync` to fetch incremental data — that is a stage-3 feature.

### 3.4 Ledger — entity coverage and routes

`LedgerService` implements `ILedgerService` (shared contract). All nine entity types have working read paths:

| Entity | Read | Write | Route |
|--------|------|-------|-------|
| Account | ✓ | ✓ (`upsertAccount`) | `GET /ledger/accounts`, `GET /ledger/accounts/:id` |
| Balance | ✓ | via normalizer | `GET /ledger/balances` |
| Transaction | ✓ | ✓ (`recordTransaction`) | `GET /ledger/transactions`, `GET /ledger/transactions/:id` |
| Counterparty | ✓ | ✓ (`upsertCounterparty`) | `GET /ledger/counterparties`, `GET /ledger/counterparties/:id` |
| Obligation | ✓ | No | `GET /ledger/obligations`, `GET /ledger/obligations/:id` |
| Invoice | ✓ | No | `GET /ledger/invoices`, `GET /ledger/invoices/:id` |
| Document | ✓ | No | `GET /ledger/documents`, `GET /ledger/documents/:id` |
| Cash Flow | ✓ (aggregate) | N/A | `GET /ledger/cash-flows` |
| Recon Match | ✓ | via `ReconciliationService` | `GET /ledger/reconciliation/matches` |

Write paths (`upsertAccountRow`, `recordTransactionRow`, `upsertCounterpartyRow`) all use `INSERT ... ON CONFLICT DO NOTHING / UPDATE` for natural idempotency. Agent-contributed rows are confidence-capped at 0.5 (`AGENT_CONTRIBUTED_CONFIDENCE_CEILING`).

`POST /ledger/reconcile` is 501 (comment: "Phase 5"). `ReconciliationService.run` exists and is called via `GET /ledger/reconciliation` (was refactored to use the existing service).

### 3.5 Normalize pipeline — state assessment

The normalize pipeline status:

```
[1] raw_artifacts (blob + DB row)     ← ingestOne writes here ✓
[2] raw_parsed (typed parsed row)     ← EMPTY — no writer exists in codebase ✗
[3] normalizeWorker polls raw_parsed  ← always finds 0 rows → permanent no-op ✗
[4] LedgerService.normalizeFromRaw    ← fully implemented for plaid_tx_v1 ✓
[5] Ledger entities (account/tx/cp)   ← never auto-populated from Plaid ✗
```

**The pipeline bridge is missing**: the stage-3 parser/extractor that reads a `raw_artifacts` blob and writes a `raw_parsed` row has not been implemented. The migration schema exists, the worker and ledger extractor are complete, but step [2] is absent.

`POST /ledger/normalize` (`services/ledger/src/routes/index.ts:215`) is wired and calls `LedgerService.normalizeFromRaw`. It would work correctly if given a valid `raw_parsed_id`, but no `raw_parsed` rows exist. The route is functional but unreachable in practice.

This is not a regression — the `0002_raw_parsed.sql` migration comment explicitly states "stage-2 only creates the schema; populated by stage-3 extractors." But it does mean that the Plaid data flow currently stops at blob storage.

### 3.6 ReconciliationService

Seven matchers, all with passing tests (148 total). Advisory lock (`pg_try_advisory_lock(hash_text(tenantId))`) prevents concurrent reconciliation runs across replicas. The lock is session-scoped (held across all matchers in one run, released in `finally`). If another replica holds the lock the current run emits `ledger.reconciliation.skipped_locked` and returns synthetic job id.

All matchers run in separate DB transactions; the advisory lock holds across them — a restart between matchers will leave some matchers complete and others pending; the next run re-runs everything (idempotent by design via `ON CONFLICT DO NOTHING`).

---

## 4. Test Coverage Assessment

| Suite | Files | Tests | Pass |
|---|---|---|---|
| `@brain/raw` | 11 | 63 | ✓ |
| `@brain/ledger` | 12 | 148 | ✓ |

Notable coverage:
- `services/raw/src/__integration__/raw.integration.test.ts` — skipped unless `DATABASE_URL` is set; no CI evidence available. Tests content-type rejection, artifact dedup, and source lifecycle.
- `services/ledger/src/workers/normalizeWorker.test.ts` — 1 test, uses pool mock. Verifies `set_config('app.tenant_id')` is called before `INSERT INTO normalization_log` (correct tenant scoping on write). Does **not** test the cross-tenant poll path or the happy-path end-to-end normalize.
- Reconciliation: All 7 matcher test files pass. `harness.ts` uses in-memory pool mock with fake rows. No live-DB tests.

---

## 5. Findings

### R-17 (Medium) — Dead `plaid@^27.0.0` dependency in `services/raw`

`services/raw/package.json:34` declares `"plaid": "^27.0.0"`. Zero files in `services/raw/src/` import from the `plaid` package (confirmed by `grep -rn "from 'plaid'"` returning no results). The raw service processes Plaid webhook payloads as raw JSON and verifies signatures via `@brain/shared`'s `verifyPlaidWebhook` — no Plaid SDK types are needed.

`services/api` correctly declares `"plaid": "^42.2.0"` and uses `PlaidApi`, `TransferAuthorizationCreateRequest`, `TransferCreateRequest`.

**Impact**: 15-version-major stale dependency in `node_modules`, potential audit noise, and the 15-major drift to the API service version could confuse developers about which SDK version to use if raw ever does need the SDK.

**Fix**: Remove `"plaid"` from `services/raw/package.json`.

---

### R-18 (Low) — Duplicate `0004` sequence number in raw migrations

Two migration files share the `0004` prefix:
- `services/raw/migrations/0004_force_rls.sql` — applies `FORCE ROW LEVEL SECURITY` to `raw_artifacts`, `raw_parsed`, `raw_plaid_items`
- `services/raw/migrations/0004_raw_plaid_items_rls.sql` — `ENABLE ROW LEVEL SECURITY` + policies on `raw_plaid_items`

The migration runner uses the full filename as a unique key (established in the database audit), so both files execute. Alphabetical sort causes `0004_force_rls.sql` to run before `0004_raw_plaid_items_rls.sql`. PostgreSQL allows `FORCE ROW LEVEL SECURITY` before `ENABLE ROW LEVEL SECURITY` — FORCE is a flag that becomes effective when RLS is later enabled. End state is correct.

**Risk**: Any tooling that deduplicates by numeric prefix, or any manual runner that processes only one file when sequence numbers conflict, will silently skip one migration. The violation of the sequential-number convention also increases cognitive load when adding future migrations.

**Fix**: Renumber `0004_raw_plaid_items_rls.sql` to `0004b_raw_plaid_items_rls.sql` (or to `0007` if the existing `0005`/`0006` files follow logically).

---

### R-19 (High) — normalize pipeline non-operational: no writer to `raw_parsed`

The raw→ledger normalize pipeline is fully implemented at both ends but the middle stage is absent:

- `raw_artifacts` is populated by every successful `ingestOne` call.
- `raw_parsed` has migration schema (`0002_raw_parsed.sql`), RLS, FORCE RLS, and correct indexes.
- **No code in the codebase writes to `raw_parsed`.** `grep -rn "INSERT.*raw_parsed" services/` returns only the `normalization_log` INSERT in `normalizeWorker.ts`.
- The `normalizeWorker` polls every 15 seconds (`services/ledger/src/workers/normalizeWorker.ts:85`) and perpetually processes zero rows.
- `LedgerService.normalizeFromRaw` + `normalizePlaidArtifact` are complete and tested, but unreachable in the current system.

**Impact**: Plaid data flow terminates at blob/artifact storage. Ledger entities (accounts, transactions, counterparties) are never auto-populated from Plaid webhook data. The empty-pipeline no-op imposes a 15s poll cycle at process startup with no useful work.

**Next step for stage-3**: Implement a parser that reads a `raw_artifacts` blob (for `source_type = 'plaid'`), extracts accounts and transactions, and inserts rows into `raw_parsed` with `parser = 'plaid_tx_v1'`. The `normalizeWorker` will then pick them up automatically.

---

### R-20 (Medium, mitigated) — normalizeWorker cross-tenant poll requires BYPASSRLS

The poll query in `normalizeWorker` reads `raw_parsed` without setting `app.tenant_id`:

```ts
// services/ledger/src/workers/normalizeWorker.ts:78–88
const result = await deps.pool.query<{ id: string; tenant_id: string }>(
  `SELECT rp.id, rp.tenant_id FROM raw_parsed rp
   WHERE rp.parser = 'plaid_tx_v1'
     AND NOT EXISTS (SELECT 1 FROM normalization_log nl WHERE nl.raw_parsed_id = rp.id)
   ORDER BY rp.extracted_at ASC LIMIT $1`,
  [batchSize],
);
```

`raw_parsed` has `FORCE ROW LEVEL SECURITY` (from `0004_force_rls.sql`). If the DB role is not BYPASSRLS, this query returns zero rows even when `raw_parsed` is populated — silently. The code documents this: "requires BYPASSRLS or superuser in production."

**Status**: Intentional cross-tenant read documented in code. The per-row normalization write is correctly scoped via `withTenantScope` in `recordNormalizationResult`. The `rls-coverage.test.ts` invariant does not cover this worker because it is not a request-path read.

**Mitigation needed**: The database audit (Turn 2) did not verify that the production DB role actually has BYPASSRLS. This must be confirmed before the normalize pipeline is activated. The security audit should verify this explicitly.

---

### R-21 (Low) — Plaid connector validation is optimistic

`services/raw/src/sources/connectors.ts:plaidConnector.validateCredentials` only checks that `access_token` is a non-empty string. It does not probe the live Plaid API. A `POST /sources/connect` call with a syntactically valid but expired/revoked token succeeds at connection time and fails only when `sync` is triggered.

**Status**: Documented as intentional for v0.3. The comment says "a follow-up wires balance-get probe." Acceptable for the current stage; should be tracked as technical debt.

---

## 6. Architecture Compliance

| Invariant | Status |
|---|---|
| Layer 1 immutability (`raw_artifacts` never mutated) | ✓ — `tombstoneArtifact` adds `tombstoned_at`; no UPDATE on content columns |
| Content-addressed dedup by sha256 | ✓ — `UNIQUE (tenant_id, sha256)` + ON CONFLICT |
| Tenant isolation (RLS on all tables) | ✓ — `raw_artifacts`, `raw_parsed`, `raw_plaid_items`, `raw_sources` all have ENABLE + FORCE RLS |
| `raw_sources` credential encryption | ✓ — AES-256-GCM via `encryptCredentials` for `plaid` and `stripe` |
| Ledger writes are idempotent | ✓ — `upsertAccountRow`, `recordTransactionRow` use ON CONFLICT |
| No PII in audit event bodies | ✓ — audit events carry hashes, ids, and byte counts only |
| Cross-service read only (Ledger reads raw_parsed) | ✓ — read-only; writes never cross layer |
| Agent-contributed confidence cap | ✓ — 0.5 ceiling enforced in `cappedConfidence` |
| Webhook dedup | ✓ — Redis idempotency key + release-on-failure pattern |

---

## 7. Functional Status

| Component | Status | Notes |
|---|---|---|
| `/raw/ingest` (multipart + JSON) | Functional ✓ | All dedup and audit paths wired |
| `/raw/webhooks/plaid` | Functional ✓ | Signature verified; artifact stored; dedup via Redis |
| `/raw/webhooks/{other}` | Stub ✗ | Returns 501 by design |
| `/raw/sources/*` lifecycle | Functional ✓ | Postgres-backed; AES-256-GCM encryption |
| Ledger reads (all entities) | Functional ✓ | Tenant-scoped, paginated |
| Ledger writes (account/tx/cp) | Functional ✓ | Idempotent upserts |
| `POST /ledger/normalize` | Wired but unreachable ⚠ | No `raw_parsed` rows exist (R-19) |
| normalizeWorker | Perpetual no-op ⚠ | Correct code, empty input (R-19) |
| ReconciliationService (7 matchers) | Functional ✓ | Advisory lock, all tests pass |
| `POST /ledger/reconcile` | Stub 501 ✗ | Docs: "Phase 5"; ReconciliationService.run exists but isn't exposed via POST |

---

## 8. Production Readiness

**Score: 7/10**

**Strengths:**
- Both test suites pass (63 + 148 tests).
- Dedup, idempotency, and audit patterns are correct throughout.
- AES-256-GCM credential encryption for Plaid/Stripe sources is implemented and wired.
- ReconciliationService is complete with 7 matchers and concurrency guard.
- RLS + FORCE RLS on all raw and ledger tables.
- Cross-service read boundary is documented and intentional.

**Blockers for "Plaid data flows to Ledger":**
- R-19 (stage-3 parser not implemented) is the single missing piece. The rest of the pipeline is ready.
- R-20 (BYPASSRLS for normalizeWorker) must be confirmed before activating the pipeline.

**Acceptable debt:**
- R-17 (dead plaid dep) — minor cleanup.
- R-18 (duplicate 0004 seq) — should be renumbered before next raw migration.
- R-21 (optimistic Plaid token validation) — acceptable for v0.3.

---

## 9. Refactor Priorities

| Priority | Action | Location |
|---|---|---|
| P1 | Implement stage-3 Plaid parser: reads `raw_artifacts` blob, writes `raw_parsed` row with `plaid_tx_v1` | New file: `services/raw/src/parsers/plaid.ts` |
| P2 | Verify/document production DB role has BYPASSRLS for normalizeWorker | `database/` audit turn, DB role config |
| P3 | Remove `"plaid": "^27.0.0"` from `services/raw/package.json` | `services/raw/package.json:34` |
| P4 | Renumber `0004_raw_plaid_items_rls.sql` to avoid duplicate prefix | `services/raw/migrations/` |
| P5 | Add live Plaid API probe in `plaidConnector.validateCredentials` | `services/raw/src/sources/connectors.ts` |

---

## 10. Confidence

| Area | Confidence | Reason |
|---|---|---|
| Raw ingestion correctness | High | All paths traced, tests pass, dedup constraint confirmed |
| Ledger entity reads/writes | High | Full code trace, 148 tests pass |
| Normalize pipeline state | High | Confirmed no writer to `raw_parsed` via grep + code trace |
| ReconciliationService matchers | High | 7 matcher tests all pass; advisory lock pattern verified |
| Production DB role for BYPASSRLS | Low | Not verified against live DB; database audit turn must confirm |
| Plaid webhook signature correctness | Medium | `verifyPlaidWebhook` from shared — implementation not traced in this turn |
| Integration path (blob → artifact → parsed → ledger) | Medium | Schema correct; live run not possible without stage-3 parser |

---

## 11. Open Questions for Subsequent Turns

1. **Database turn**: Does the production DB role (`brain_app`) have BYPASSRLS? Which migrations actually configure this?
2. **Integrations turn**: What does `verifyPlaidWebhook` in `@brain/shared` implement? Is it JWK-based or HMAC?
3. **Architecture turn**: Is the "stage-3 extractor" gating on an architectural decision (separate microservice vs. in-process) or purely a backlog item?
4. **Security turn**: Are the AES-256-GCM keys (`CREDENTIAL_ENCRYPTION_KEY`) in env-var-based secrets management? What is the rotation story for `credentialKeyId`?
