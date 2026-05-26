# Hardening run — blockers

Tracked blockers encountered during the autonomous hardening run (P0/P1/P2).
Each entry: what was attempted, what's needed, who can unblock.

---

## B-1 — No live infrastructure in the execution environment

**Status:** resolved in CI (2026-05-26). The local environment still has no
Docker/Postgres/Redis, so the suites below remain skip-guarded locally — but
they now **run and pass in CI**. `main.yml`'s `unit + integration` job is green,
including the P0.2 invariants and P1.1 adversarial DB-integration suites and the
raw integration tests, and the P0.6 `golden-path` smoke job seeds + runs.
(Getting there required CI repairs tracked in `HARDENING-SUMMARY.md` →
"Post-merge status".) Original detail retained below for history.

**What was attempted:** Verifying DB/infra-dependent tasks locally. The sandbox
has **no Docker daemon, no Postgres, no Redis, no `psql`, and `DATABASE_URL` is
unset**. `pnpm run dev:up` cannot start the pg+pgvector / redis / localstack
containers.

**Impact:** The following deliverables are implemented to run in **CI** (where
Postgres+Redis are available) and are **skip-guarded locally** (they no-op when
`DATABASE_URL` is absent, mirroring `services/raw/src/__integration__/harness.ts`).
They could **not be executed/verified in this environment**:

- P0.2 — `tests/invariants/integration/db-invariants.integration.test.ts`
- P0.3 — wiki annotation rate limiter (Redis sliding-window) integration path
- P0.6 — `scripts/demo/golden-path.sh` end-to-end run + `docker-compose.smoke.yml`
- P0.7 — proof-viewer end-to-end render against a real intent
- P1.1 — `tests/adversarial/` DB-backed attack-vector suite

Everything that does **not** require infra (gate logic, unit tests, type/shape
tests, docs, CI wiring, Dockerfiles) was fully verified locally.

**What's needed to unblock:** Run the new suites against the dev stack:
`pnpm run dev:up && DATABASE_URL=… pnpm -C tests/invariants run test:integration`
(and the adversarial / smoke equivalents). CI already provisions Postgres+Redis,
so the CI job is the canonical verifier.

**Who can unblock:** Anyone running CI, or a local run with Docker available.

---

## B-2 — `main.yml` deploy chain fails: Azure credentials not configured

**Status:** open (external; owned by the team — deliberately not gated, per
decision to add secrets rather than skip the jobs).

**What was found:** With the quality gates green, the `main.yml` deploy jobs run
on every push to `main` and fail fast at **`Azure login (OIDC)`**:
`Login failed... Ensure 'client-id' and 'tenant-id' are supplied.` The repo has
no `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` secrets, so
`build + push container images` (8-service matrix) → `deploy → staging` →
`E2E → staging` → `promote → production` cannot run. This keeps the **overall**
`main.yml` run red even though all test/quality jobs pass.

**Secondary effect:** the 8 always-failing `build + push` matrix jobs start in
parallel with `golden_path_smoke` (both `needs: unit_and_integration`) and
intermittently **starve/cancel** golden-path before it gets a runner — so that
job is occasionally cancelled while queued despite being correct.

**What's needed to unblock (pick one):**

1. Configure the Azure OIDC secrets + federated-credential trust, so the deploy
   jobs authenticate and run (the chosen path).
2. Or gate the deploy jobs behind a flag (e.g. `if: vars.DEPLOY_ENABLED == 'true'`)
   so they skip — turning `main.yml` green on the quality gates and removing the
   golden-path scheduling contention — until secrets are ready.

**Who can unblock:** the team that owns the Azure subscription / repo secrets.
