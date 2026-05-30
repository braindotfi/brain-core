# Risk register

Structured enterprise diligence artifact. For each open risk: the current
mitigation, the owner, the status, the exit criteria, and the evidence
link that lets a diligence reviewer verify the claim themselves.

Updated when a risk's status changes (open / mitigating / closed) or when
exit criteria evolve. Each entry is the answer to "what could go wrong, and
what stops it from going wrong, and how do I know?".

> Audience: enterprise buyers, security reviewers, due-diligence counsel.
> For internal engineering risk tracking, see `docs/audit/index.md` (the
> deeper-detail findings register).

## Open risks

### R-01. External smart-contract audit not yet complete (BrainEscrow)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risk               | `BrainEscrow` custodies USDC on Base. Deploying to mainnet before external audit signoff would expose tenant funds to undiscovered contract bugs.                                                                                                                                                                                                                                                                                                                |
| Current mitigation | (1) Mainnet deploy is **boot-fenced**: `composition/escrow-audit-gate.ts` refuses to start the api when `BRAIN_BASE_CHAIN_ID === 8453 && BRAIN_ESCROW_ADDRESS` is set unless `BRAIN_ESCROW_AUDIT_APPROVED="true"` (operator attestation). (2) CI guard (`check-escrow-audit-marker`) catches the same misconfig at PR-review time before the boot fence has to fire. (3) The contract itself has internal review + Foundry property tests covering 4 invariants. |
| Owner              | Engineering + external auditor (TBD)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Status             | **open**. Engagement pending                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Exit criteria      | (a) external audit completes with no critical or high findings, (b) audited commit SHA + tag pinned in `contracts/AUDIT-SCOPE.md`, (c) deployed mainnet bytecode verified to match audited bytecode on a block explorer, (d) `BRAIN_ESCROW_AUDIT_APPROVED="true"` enabled in production env                                                                                                                                                                      |
| Evidence           | `contracts/AUDIT-SCOPE.md`, `services/api/src/composition/escrow-audit-gate.ts`, `scripts/check-escrow-audit-marker.mjs`, `contracts/test/BrainEscrow.t.sol`                                                                                                                                                                                                                                                                                                     |

### R-02. Tenant blob purge not implemented (GDPR Article 17 gap)

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risk               | `DELETE /v1/tenants/{id}` removes database rows but does not erase the user's raw blob artifacts in Azure Blob Storage (bank statements, invoice PDFs). A user filing an Article 17 demand could receive a "deleted" response while their PII persists.                                                                                                                                        |
| Current mitigation | (1) The deletion endpoint surfaces the blob URI list as `blobUrisPendingPurge` on the response + on the `tenant.deleted` audit event, so an operator can run a manual purge pass and the act of "not yet erased" is on-chain. (2) Architectural decision is documented in RFC 0003 (`docs/rfcs/0003-blob-purge-article-17.md`); phase A landed, phase B (durable purge worker) awaits signoff. |
| Owner              | Engineering                                                                                                                                                                                                                                                                                                                                                                                    |
| Status             | **mitigating**. Phase A shipped, phase B drafted, awaiting signoff                                                                                                                                                                                                                                                                                                                             |
| Exit criteria      | Phase B ships per RFC 0003 §5: (a) `tenant_blob_purge_jobs` migration, (b) `BlobAdapter.purge()` on memory/s3/azure, (c) `tenant-blob-purge-worker.ts`, (d) `check-blob-purge-callsites.mjs` lint guard, (e) integration test proving end-to-end erasure                                                                                                                                       |
| Evidence           | `docs/rfcs/0003-blob-purge-article-17.md`, `services/api/src/tenant-deletion/service.ts`, `services/api/src/tenant-deletion/service.test.ts`                                                                                                                                                                                                                                                   |

### R-03. Azure production deploy chain not yet exercised

| Field              | Value                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risk               | The codebase ships GitHub Actions workflows for build/push/deploy, but Azure OIDC secrets are not provisioned and the deploy chain has not been run against a live Azure environment. Production-readiness claims are theoretical until proven.                                                                                  |
| Current mitigation | Disclosed explicitly in `architecture/enterprise-readiness.md` under "Blockers for unrestricted mainnet production." All other safety controls (boot fences, gate, audit, RLS) are runtime-independent and would survive any deploy substrate.                                                                                   |
| Owner              | Operations (TBD)                                                                                                                                                                                                                                                                                                                 |
| Status             | **open**. Operational milestone                                                                                                                                                                                                                                                                                                  |
| Exit criteria      | (a) Azure OIDC secrets configured (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`), (b) build → push → deploy → staging-validation chain runs cleanly end-to-end, (c) production deploy logs show all 5 boot fences armed via `brain.runtime.capabilities` line, (d) rollback procedure exercised against staging |
| Evidence           | `.github/workflows/main.yml`, `architecture/enterprise-readiness.md`, `docs/rollback.md`                                                                                                                                                                                                                                         |

### R-04. Full money-movement E2E not yet enforced in CI

| Field              | Value                                                                                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risk               | `tests/e2e/signed-agent-gated-payment.e2e.test.ts` asserts §6 gate dormancy when staging history exists but skips when fixtures are missing. The full chain (propose → gate → audit-before → outbox → rail → receipt → audit-after → proof verify) is not enforced as a per-PR signal.                           |
| Current mitigation | (1) `scripts/demo/golden-path.sh` runs the full chain end-to-end with `BRAIN_DEMO_STRICT_PROOF=true` blocking until proof verifies. (2) §6 gate has property + unit + integration tests under `shared/src/gate/`. (3) Per-check metrics surface dormancy via `brain.gate.outcome.count{outcome=not_applicable}`. |
| Owner              | Engineering + infra                                                                                                                                                                                                                                                                                              |
| Status             | **mitigating**. Strict-mode demo + e2e probe in place; CI-enforced full E2E pending deterministic stack-in-CI work                                                                                                                                                                                               |
| Exit criteria      | (a) deterministic local-stack-in-CI (pg + redis + localstack + boot binary in GH Actions), (b) the golden-path demo runs in strict mode on every PR, (c) any check 8 / 9.5 / 11.5 going `not_applicable` fails the build, (d) audit-before → audit-after linkage asserted                                        |
| Evidence           | `tests/e2e/signed-agent-gated-payment.e2e.test.ts`, `scripts/demo/golden-path.sh`, `infra/grafana/gate.json`                                                                                                                                                                                                     |

## Recently closed

### R-05. Rail catalog vs docs drift (closed batch 6 P1)

| Field              | Value                                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risk               | The rail catalog (`services/api/src/composition/rail-catalog.ts`) is the runtime source of truth; the rails matrix doc (`docs/rails-matrix.md`) is the buyer-facing reference. Drift between them would damage diligence trust.                       |
| Current mitigation | `check-rails-catalog-drift` CI guard (wired into `pnpm run lint`) compares both files and fails on any divergence in name, `productionAllowed`, `auditRequired`, or `requiredEnv` set. Two parsers share a contract so format changes break together. |
| Status             | **closed**. Drift is now structurally impossible at PR merge time                                                                                                                                                                                     |
| Evidence           | `scripts/check-rails-catalog-drift.mjs`, the script's unit-test fixtures simulate every drift class                                                                                                                                                   |

## Risks NOT in this register

This register tracks **enterprise-diligence-facing** risks. Internal
engineering items (refactor backlog, technical debt, deprecation
schedules) live in `docs/audit/index.md` and the project task tracker.
The two registers don't compete; they answer different questions:

| Register                | Question it answers                                                  |
| ----------------------- | -------------------------------------------------------------------- |
| `docs/risk-register.md` | What could a buyer or auditor be concerned about, and what stops it? |
| `docs/audit/index.md`   | What does the engineering team need to fix or refactor before v0.4?  |

A risk graduates from internal to enterprise-facing when it has
diligence-blocking potential (custody safety, GDPR compliance, deploy
provability, contract security).
