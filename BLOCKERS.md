# Hardening run — blockers

Tracked blockers encountered during the autonomous hardening run (P0/P1/P2).
Each entry: what was attempted, what's needed, who can unblock.

---

## B-1 — No live infrastructure in the execution environment

**Status:** open (environmental; does not block writing deliverables)

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

## B-2 — `main` is currently red; its coverage debt blocks `test:coverage`

**Status:** open (external; owned by the team, not this run)

**What was found:** After merging `origin/main` into the hardening branches (to
clear the PR conflict), CI surfaced that **`main`'s own CI is failing**
(`origin/main` @ `dce216f8a` → `completed/failure`). Two causes, both pre-existing
on `main` and inherited via the merge:

1. **`test:coverage`** — `main` shipped files with no tests, dragging packages
   under the 80% gate: `services/raw/src/sources/PostgresSourceRepository.ts`
   (9% lines / 0% funcs), `services/api/src/rails/onchainExecutor.ts` and
   `rails/plaidClient.ts` (0%). Confirmed: these have **no `*.test.ts` on
   `origin/main`** and the coverage configs do not exclude them.
2. **`contracts`** — transient `foundryup` GitHub-API `403` (toolchain install
   rate-limit); `forge` never installed. Infra flake, clears on re-run.

**Not caused by this run.** The one coverage shortfall attributable to the
hardening work — `proof/view.ts` (78.86%) — was fixed (route tests → 95% lines /
100% funcs, commit `19c6bea`). No remaining `test:coverage` red is from P0/P1/P2.

**What's needed to unblock:** the team adds tests (or coverage `exclude`s) on
`main` for `PostgresSourceRepository` + `rails/{onchainExecutor,plaidClient}`.
Once `main` is green, re-merging it into these branches (same merge-based flow)
makes all three PRs pass. (Chosen path: option **(a)** — fix on `main`.)

**Who can unblock:** the team that owns `main`'s rails/sources work.
