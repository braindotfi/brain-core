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
- `pnpm run test:coverage` — every suite **passes** and all hardening code meets
  the 80/80/75/80 gate (after `proof/view.ts` was raised to 95% lines / 100%
  funcs, `19c6bea`). **However**, the aggregate `test:coverage` is **RED** because
  the merge with `main` pulled in `main`'s untested files (`PostgresSourceRepository.ts`
  9%, `rails/{onchainExecutor,plaidClient}.ts` 0%) — `main`'s own CI is currently
  failing on the same. This is inherited debt, **not** from this run (see
  `BLOCKERS.md` B-2). The local `shared/config.test.ts > loadConfig` case also
  fails on missing ambient `ANTHROPIC_API_KEY` (set in CI; shared is not in the
  `test:coverage` filter anyway).

## Re-sync with `main` (post-PR)

`main` advanced 3 commits (rails / sources / force-RLS) during the run, so #14
went `DIRTY`. Resolved without force-push:

- Merged `origin/main` into all three branches (merge-based; merge commits
  `7a486cf` → `ebc8f09` → `94cce2c`, then the view-coverage fix `19c6bea` →
  `b6138cf` → `3c7ef6b`). Only `services/api/src/main.ts` truly conflicted —
  resolved **additively** (kept both the P0 wiring and `main`'s on-chain/Plaid
  rail + credential resolvers).
- Renamed migration `0019_approvals_hardening.sql` → `0020` to clear a collision
  with `main`'s new `0019_force_rls.sql`.
- Fixed a pre-existing `consistent-type-imports` error and applied prettier to
  files `main` left unformatted (`raw/server.ts`, `rails/plaidClient.ts`,
  `sources/*`) so the lint gate passes.
- All three PRs are now **`MERGEABLE`** (was `DIRTY` on #14). `lint` / `typecheck`
  / `build` / `test` green on each tip.

## Blockers (`BLOCKERS.md`)

- **B-1 — No live infrastructure in the dev environment** (open, environmental):
  no Docker / Postgres / Redis / `psql`, `DATABASE_URL` unset. DB/infra-dependent
  deliverables are implemented to run in CI and skip-guarded locally; verified by
  typecheck/build, not by execution here.
- **B-2 — `main` is currently red; its coverage debt blocks `test:coverage`**
  (open, external): `main` shipped `PostgresSourceRepository.ts` /
  `rails/{onchainExecutor,plaidClient}.ts` with no tests, so the merged branches
  inherit a failing `test:coverage`. Chosen path: option (a) — fix on `main`,
  then re-merge so the PRs inherit green. None of this red is from P0/P1/P2.

## Smart-contract audit status (after P2.1)

**RFP drafted; engagement pending founder approval.** See
`contracts/AUDIT-SCOPE.md` and `contracts/AUDIT-RFP-DRAFT.md`; `SECURITY.md`
records the same.

## PRs

All three opened (after installing `gh`), labeled `ai-assisted` (Standards
§13.4), **stacked** (each builds on the previous so P1 tests can exercise P0
code). All currently **`MERGEABLE`** — **open, not merged**.

| PR                                                         | Head → Base                                 | Mergeability                       |
| ---------------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| [#14](https://github.com/braindotfi/brain-core/pull/14) P0 | `brain/hardening-p0` → `main`               | MERGEABLE (CI red = inherited B-2) |
| [#15](https://github.com/braindotfi/brain-core/pull/15) P1 | `brain/hardening-p1` → `brain/hardening-p0` | MERGEABLE                          |
| [#16](https://github.com/braindotfi/brain-core/pull/16) P2 | `brain/hardening-p2` → `brain/hardening-p1` | MERGEABLE                          |

**Merge order:** #14 → #15 → #16 (GitHub auto-retargets the next to `main` as
each lands). **Gate status:** `lint`/`typecheck`/`build` pass; `test:coverage` is
red **only** on `main`'s inherited coverage debt (B-2), and `contracts` hit a
transient `foundryup` flake. Per decision (a), `main` is fixed first; re-merging
it here then turns all three green.

## Post-merge status (update — 2026-05-26)

All three hardening PRs are **merged to `main`**:

| Phase | PR                                                                                                                                        | Merge commit |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| P0    | [#14](https://github.com/braindotfi/brain-core/pull/14)                                                                                   | `7a81907`    |
| P1    | [#21](https://github.com/braindotfi/brain-core/pull/21) (replaced #15, which GitHub auto-closed when its stacked base branch was deleted) | `f27e405`    |
| P2    | [#16](https://github.com/braindotfi/brain-core/pull/16)                                                                                   | `d4e4321`    |

**B-2 (the old "`main` is red") is resolved.** `main`'s pre-existing CI debt was
fixed in a follow-up `fix/main-green` effort (PRs #17–#26) using **real unit
tests — no coverage `exclude`s** — plus a `compareDecimal` `-0` bug fix and a
series of CI repairs that `main.yml` had hidden behind its lint failure:

- **Coverage backfill:** raw `PostgresSourceRepository`; api rails
  (`onchainExecutor` / `plaidClient` / `viemPolicySignerChecker`); execution
  `agent-runs` + `findings`; internal-agent handlers; agent-router barrel/config.
- **`main.yml` repair:** build-before-typecheck; just-in-time `tools/*` build
  (the migrate + golden-path seed CLIs the root build excludes); restored wiki's
  missing integration vitest config + `passWithNoTests` for ledger/wiki; moved
  `--if-present` before the script name; added the missing `pg` runtime dep to
  the invariants/adversarial integration suites; made the RLS-isolation probes
  connect as a **non-owner role** (Postgres bypasses RLS for the superuser owner);
  authenticated `foundry-toolchain` to stop the 403 flake.
- **Golden-path smoke:** seed `BRAIN_TENANT_ID`/`BRAIN_ACTOR` env (the demo
  golden tenant); read the real ledger JSON keys (`invoices` / `counterparties`);
  satisfy the P0.5 invoice-shortcut preconditions in the seed (linked document
  evidence + a default AP account).

**CI status on `main`:** the **quality gates are green** — `pr.yml`
(lint/build/typecheck/test:coverage/contracts/secret-scan) and `main.yml`'s
`unit + integration` job (incl. P0.2 invariants + P1.1 adversarial DB-integration).
The **only** remaining red is the Azure deploy chain (`build + push` →
`deploy` → `E2E` → `promote`), which fails on missing Azure OIDC secrets — see
`BLOCKERS.md` **B-2**. No fix PR reaches it; it needs repo secrets (or gating).
