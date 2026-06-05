# Enterprise readiness

Single diligence-facing index for fintech, bank, and platform buyers. For each enterprise concern, this page names the runtime guarantee, the code/test that enforces it, and the doc that explains it. So buyers don't have to read the source to answer "is this safe?".

{% hint style="info" %}
**Status as of `main`.** Anything marked **deferred** is on the engineering roadmap. Anything marked **external** depends on a third party (audit, Azure provisioning). The two **blockers** for unrestricted mainnet production are at the bottom of this page.
{% endhint %}

## At a glance

| Concern                              | Status       | Runtime / code anchor                                                                     |
| ------------------------------------ | ------------ | ----------------------------------------------------------------------------------------- |
| Tenant isolation (DB)                | shipped      | Postgres RLS + `infra/db-roles.sql` + `composition/db-isolation.ts`                       |
| Tenant isolation (blob)              | shipped      | Per-tenant path prefix `<tenantId>/yyyy/mm/dd/sha256` (`blobPath`)                        |
| Wiki / Policy boundary               | shipped      | `check-policy-no-wiki-read` + `check-wiki-no-ledger-write`                                |
| Credential encryption at rest        | shipped      | AES-256-GCM + KMS provider (`shared/src/crypto/aes-gcm.ts`)                               |
| §6 deterministic payment gate        | shipped      | `shared/src/gate/gate.ts` (23 entries) + `check-gate-bypass`                              |
| External-agent HMAC handshake        | shipped      | `services/api/src/agents/sign-agent-request.ts` (signs and verifies)                      |
| MCP scope grants + per-tenant limits | shipped      | `BrainMCPAgentRegistry` + `services/mcp/src/server.ts`                                    |
| Audit log immutability               | shipped      | Append-only DB + Merkle anchoring on Base                                                 |
| Audit log retention                  | shipped      | Preserved through tenant deletion (GDPR Art 17(3)(b))                                     |
| Tenant deletion                      | shipped      | `DELETE /v1/tenants/{id}` + 11 unit tests                                                 |
| Tenant blob purge                    | deferred     | URIs surfaced; durable purge worker in RFC                                                |
| Production boot fences (5)           | shipped      | `composition/{db-isolation,escrow-audit-gate,rails-prod-fence}.ts` + AES + INBOUND_SECRET |
| Webhook delivery DLQ + retries       | shipped      | `services/audit/src/webhook-dispatch-worker.ts`                                           |
| On-chain PII guard                   | shipped      | `check-no-onchain-pii` + RFC 0001 §3                                                      |
| Per-tenant MCP rate limits           | shipped      | `services/mcp/src/server.ts` (Redis-backed)                                               |
| External smart-contract audit        | **external** | `contracts/AUDIT-SCOPE.md` ready, engagement pending                                      |
| Azure production deploy              | **external** | OIDC secrets + GitHub Actions chain pending                                               |

## Detail

### Tenant isolation at the storage layer

**Database.** Postgres Row-Level Security is `ENABLE`d on every tenant table by migration. Enforcement requires `infra/db-roles.sql` to be applied in production (separates `brain_app` from `brain_privileged` with `BYPASSRLS`). A boot fence (`composition/db-isolation.ts`) refuses to start the api in `NODE_ENV=production` when `BRAIN_WIKI_DB_URL` or `DATABASE_PRIVILEGED_URL` is missing.

**Blob storage.** Every object lives under `<tenantId>/yyyy/mm/dd/sha256`. Paths are built by `blobPath()` in `shared/src/blob/types.ts` and never concatenated by hand. An RLS test against the non-owner `brain_app` role pins the boundary.

### Wiki / Policy boundary

Brain's safety story rests on Policy reading **Ledger only**, never Wiki.

- `check-policy-no-wiki-read` (CI) scans Policy code for any Wiki import.
- `check-wiki-no-ledger-write` (CI) scans Wiki code for any Ledger write.
- 15 cross-layer invariants in `tests/invariants/` enforce this end-to-end.

### Credential encryption at rest

Plaid bank credentials are encrypted with **AES-256-GCM** before insert into `raw_plaid_items.credentials`. The key comes from Azure Key Vault in production (`shared/src/crypto/kms-provider.ts`) or `BRAIN_SOURCE_CREDENTIAL_KEY` in dev. A boot fence refuses to start in production with no provider configured.

### The §6 deterministic pre-execution gate

Every money-moving action runs 23 deterministic checks (13 numbered + 10 hardening additions). Identity, behavior pinning, policy DSL, ledger state binding, balance, evidence, approvals, duplicate detection, obligation direction (payable vs receivable), audit before and after.

{% hint style="success" %}
**No LLM. No Wiki text. No skip path.** The gate is pure code; the same inputs always produce the same outputs.
{% endhint %}

- `check-gate-bypass` (CI) enforces that no rail dispatch or `executed` transition can occur outside `PaymentIntentService.execute()`.
- Metrics: `brain.gate.check.count`, `brain.gate.outcome.count`, `brain.gate.duration_ms` (Grafana scaffold at `infra/grafana/gate.json`).
- `tests/e2e/signed-agent-gated-payment.e2e.test.ts` asserts checks 8 / 9.5 / 11.5 are `pass` and NOT `not_applicable` from staging history.

### External-agent HMAC handshake

External MCP agents call `/v1/agents/mcp` with a JWT validated against `BrainMCPAgentRegistry` (60s cache). Internal Python agents (reconciliation, payment, anomaly) verify `X-Brain-Auth: sha256=<hex>` over the request body via shared `BRAIN_AGENTS_INBOUND_SECRET`. Both sides fail closed in production:

- The api refuses to start when `RECONCILIATION_AGENT_URL` is set in prod without `BRAIN_AGENTS_INBOUND_SECRET`.
- The Python service raises `RuntimeError` before `FastAPI` is constructed when `BRAIN_ENV=production` and the secret is unset.

### Audit log + Merkle anchoring

Append-only `audit_events` table. Periodic Merkle anchor publication to Base via `BrainAuditAnchor`. The `/v1/audit/verify` endpoint is unauthenticated (verify-without-trusting-Brain). Tenant deletion preserves `audit_events` and `audit_anchors` under GDPR Article 17(3)(b) legitimate-interest carveout (financial integrity), and the deletion itself is recorded as a `tenant.deleted` audit event so it's verifiable on the chain.

### Tenant deletion (GDPR Article 17)

`DELETE /v1/tenants/{id}` walks every tenant-scoped table across the six layers in one transaction (`brain_privileged` role, BYPASSRLS). Returns per-table row counts + the list of `raw_artifacts.blob_uri` that require out-of-band purging (the database deletion is in-band; blob byte deletion is **deferred** to the privileged purge worker).

### Blob purge (deferred)

{% hint style="warning" %}
**This item is on the roadmap, not shipped.** A misconfigured operator runbook could leave blob bytes in Azure Blob Storage after a tenant deletion.
{% endhint %}

Layer-1 immutability ("Raw is the source of truth, never mutated", per `Brain_MVP_Architecture.md` Layer 1) blocks an in-band `BlobAdapter.purge()` today. The architectural carveout that reconciles Layer-1 immutability with GDPR Article 17 is in RFC 0003 (in the repo at `docs/rfcs/0003-blob-purge-article-17.md`). Once signed off, phase B implements:

- `tenant_blob_purge_jobs` durable queue table
- background worker that calls `BlobAdapter.purge(uri)` per row
- audit events `tenant_blob.purge_requested / completed / failed / retried`

Until phase B lands, operators run a separate cleanup pass against the URI list returned by the deletion endpoint.

### Production boot fences (5)

Five fail-closed boot fences. A misconfigured production deploy fails to start (CrashLoopBackoff in k8s) rather than running degraded:

1. **DB isolation** (`composition/db-isolation.ts`). Wiki + privileged DB URLs required.
2. **Escrow audit** (`composition/escrow-audit-gate.ts`). Mainnet escrow requires `BRAIN_ESCROW_AUDIT_RECEIPT` (preferred. URL/filepath/hash pointing at the audit report) or the legacy `BRAIN_ESCROW_AUDIT_APPROVED="true"` boolean.
3. **Live rails** (`composition/rails-prod-fence.ts`). At least one production rail must register.
4. **AES-256-GCM**. Source-credential KMS provider must be configured.
5. **Inbound agent secret**. `BRAIN_AGENTS_INBOUND_SECRET` required when `RECONCILIATION_AGENT_URL` is set.

All five emit the failure on stdout/stderr so log aggregators surface the exact missing env var.

### Per-tenant MCP rate limits

Redis-backed limiter in `services/mcp/src/server.ts`. Per-tenant + per-tool buckets. Configurable via env. No customer can starve another via the MCP surface.

### Per-rail support matrix

A release-manager-facing per-rail support table lives in the repo at `docs/rails-matrix.md` (production_allowed, required env, chain, audit status, failure mode). The runtime capability log emits the same fields per rail at boot:

```
brain.runtime.capabilities { ..., rails: [ {name, live, production_allowed,
  required_env_present, chain_id, audit_required, audit_approved}, ... ] }
```

## Diligence machinery (peer-review batch 7)

Beyond the runtime guarantees above, Brain ships repeatable operator and reviewer tooling that turns "is this safe to promote?" into a runnable check:

- **`pnpm run production-readiness`** evaluates the current env against every boot fence, every rail's `required_env_present`, every CI guard's wiring, and every open risk in the register. Exit 1 (red) when any P0 risk is open or any fence would fail. Add `--json` for machine output.
- **Machine-readable risk register** at `docs/risk-register.json` (mirrors `docs/risk-register.md`). The aggregator reads it directly; an open `P0` risk in the register automatically pins promotion to red.
- **CI artifact** uploaded per commit on the PR workflow (`production-readiness-${sha}`, 90-day retention). Diligence reviewers can pull any commit's readiness JSON without rebuilding.
- **Git-native trend tracking** at `docs/readiness-history/<tag>.json`. Per-release snapshots committed to the repo; `pnpm run readiness-trend` prints the trajectory (open P0 count, red/yellow/green counts, ΔP0 vs prior). No external dashboard required.

This is how the readiness story stays falsifiable: every claim has a code anchor, every claim has a runtime check, and every release has a snapshot you can compare against.

## Blockers for unrestricted mainnet production

{% hint style="danger" %}
**Two items must close before "production-ready" is an honest claim.** Until then, Brain is staging / controlled-pilot ready.
{% endhint %}

1. **External smart-contract audit.** `contracts/AUDIT-SCOPE.md` is ready. Engagement is pending. Until the audit clears and the deployed bytecode is verified, the boot fence (#2 above) refuses mainnet escrow.
2. **Azure production deploy.** The codebase ships with GitHub Actions, the OIDC secrets are not yet provisioned, and the deploy chain has not been exercised against a live Azure environment.

## How to verify any one of these claims

Each row in the at-a-glance table names the code anchor. Reading that file is the verification. For runtime guarantees, the `brain.runtime.capabilities` log line is the single ops surface that proves which fences are armed and which rails are live in the running process.
