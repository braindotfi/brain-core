# Hardening run — summary

Autonomous hardening pass (P0/P1/P2). Three stacked branches:
`brain/hardening-p0` → `brain/hardening-p1` → `brain/hardening-p2`.

## Per-task status

| Task                                     | Status | Commit                        | Tests added (local-run unless noted) |
| ---------------------------------------- | ------ | ----------------------------- | ------------------------------------ |
| P0.1 mandatory behavior-hash pinning     | done   | `0df3ae8`                     | 5 (gate)                             |
| P0.2 DB-integration invariants           | done   | `d355549`                     | 5 (CI-only — DATABASE_URL)           |
| P0.3 wiki annotation rate limiting       | done   | `7fc4227`                     | 5 (3 limiter + 2 route)              |
| P0.4 approver/quorum hardening           | done   | `4c1a236`                     | 9 (7 ApprovalService + 2 gate)       |
| P0.5 invoice shortcut resolution         | done   | `cce4c3a`                     | 10 (resolver)                        |
| P0.7 human-readable proof viewer         | done   | `ec161d4`                     | 6 (render)                           |
| P0.6 golden-path command + smoke         | done   | `854426a`                     | CI smoke job (bash syntax-checked)   |
| P1.2 MCP no-execute defense              | done   | `e16dcfd`                     | 3 (+ snapshot)                       |
| P1.3 property + fuzz Merkle inclusion    | done   | `2f17455`                     | 1 fast-check (+ Foundry fuzz, CI)    |
| P1.4 CSP + security headers              | done   | `256e876`                     | 3 (headers)                          |
| P1.6 align services/execution naming     | done   | `973b6c7`                     | docs (grep-zero verified)            |
| P1.7 document 13+4 checks                | done   | `e308b17`+`19349af`+`a54d124` | docs                                 |
| P1.8 SECURITY.md                         | done   | `232fe5b`+`15da7f2`           | docs                                 |
| P1.9 RPO/RTO doc                         | done   | `ae9eb92`                     | docs                                 |
| P1.5 per-service Dockerfiles             | done   | `b6ca8b1`                     | CI build matrix (no local Docker)    |
| P1.1 adversarial safety suite            | done   | `f54dc02`                     | 10 (logic) + integration (CI)        |
| P2.1 smart-contract audit prep           | done   | `631a4ec`                     | docs                                 |
| P2.2 pgvector scaling plan               | done   | `da58e94`                     | docs                                 |
| P2.3 pgBouncer rollout plan              | done   | `d71bd5c`                     | docs                                 |
| P2.4 compliance hard-gate representation | done   | `79559c9`                     | docs                                 |

All 20 tasks: **done**. None blocked. The CI-only / build-only items below were
implemented + wired into CI but could not be executed in the dev environment
(no Docker / Postgres / Redis — see `BLOCKERS.md` B-1): P0.2, P0.6, P1.5, P1.1
integration, P1.3 Foundry. They are type-/syntax-/build-graph-validated locally.

## Aggregate deltas

- **Test count:** ~52 new tests run + pass locally (gate 5, rate-limit 5,
  approvals/gate 9, invoice 10, proof 6, MCP 3, Merkle property 1, headers 3,
  adversarial 10) + ~16 CI-only/build-only (P0.2 ×5, P1.1 integration, P1.3
  Foundry fuzz, etc.).
- **Diff:** 73 files changed, **+4179 / −117** across the three branches.
  Approx split: production TS/SQL ~1100, tests ~1500, docs/YAML/Docker ~1500.

## Verification (full stack, p2 tip)

- `pnpm run build` — ✅ all packages
- `pnpm run typecheck` — ✅ all packages
- `pnpm run lint` — ✅ (eslint + prettier + scope-vocab + gate-bypass +
  wiki-no-ledger-write + policy-no-wiki-read + OpenAPI valid; 56 pre-existing
  OpenAPI warnings, non-fatal)
- `pnpm run test:coverage` — per-package suites pass; the only failure anywhere
  is the **pre-existing** `shared/src/config.test.ts > loadConfig` case, which
  reads ambient `process.env` and needs `ANTHROPIC_API_KEY` (set in CI, unset in
  this dev shell). Unrelated to this run.

## Blockers (`BLOCKERS.md`)

- **B-1 — No live infrastructure in the dev environment** (open, environmental):
  no Docker / Postgres / Redis / `psql`, `DATABASE_URL` unset. DB/infra-dependent
  deliverables are implemented to run in CI and skip-guarded locally; verified by
  typecheck/build, not by execution here.

## Smart-contract audit status (after P2.1)

**RFP drafted; engagement pending founder approval.** See
`contracts/AUDIT-SCOPE.md` and `contracts/AUDIT-RFP-DRAFT.md`; `SECURITY.md`
records the same.

## PRs

`gh` is not installed in this environment, so the three PRs could not be opened
programmatically. The branches are **stacked** (each builds on the previous so
P1 tests can exercise P0 code), so open the PRs with these bases:

| PR                 | Head branch          | Base branch          |
| ------------------ | -------------------- | -------------------- |
| `[ai-assisted] P0` | `brain/hardening-p0` | `main`               |
| `[ai-assisted] P1` | `brain/hardening-p1` | `brain/hardening-p0` |
| `[ai-assisted] P2` | `brain/hardening-p2` | `brain/hardening-p1` |

Label each `ai-assisted` (Standards §13.4). After P0 merges, retarget P1's base
to `main` (and likewise P2), or merge in order.
