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
