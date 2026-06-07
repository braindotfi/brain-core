# ADR 0005: RLS role separation enforces tenant isolation

- Status: Accepted
- Date: 2026-06-07

## Context

Tenant isolation implemented as "every query remembers to add `WHERE tenant_id =
$current`" fails the first time one query forgets. For a multi-tenant financial
system, a single cross-tenant leak is a reportable incident. Isolation must live
below the application, at the storage layer, where forgetting is not an option.
Postgres also skips RLS for a table's owner, so simply enabling RLS is not
enough.

## Decision

Tenant isolation is enforced by Postgres Row Level Security on every table, under
a deliberate role model. Migrations arm RLS (`ENABLE ROW LEVEL SECURITY`), but
enforcement requires the role model in `infra/db-roles.sql`: the application runs
as a **non-owner** `brain_app` role with `FORCE ROW LEVEL SECURITY` (so the
owner-skips-RLS rule does not apply). A separate `brain_privileged` BYPASSRLS
role is used only by a small, named set of legitimate cross-tenant jobs
(normalize worker, Plaid webhook resolver, SIWX registry, audit emitter,
anchoring). Shared-query-with-filter is not acceptable for tenant data.

## Consequences

- A forgotten `WHERE tenant_id` clause cannot leak data: the database refuses
  rows outside the session tenant.
- Cross-tenant access is an explicit, reviewable choice (running as
  `brain_privileged`), not an accident.
- Blob storage mirrors this with per-tenant path prefixes.

## Enforced by

- `infra/db-roles.sql`: `FORCE ROW LEVEL SECURITY` plus the non-owner
  `brain_app` / `brain_privileged` role split.
- `tests/adversarial/`: tenant-isolation property tests.
- CI guards keep cross-layer reads/writes on the sanctioned paths
  (`check-wiki-no-ledger-write`, `check-policy-no-wiki-read`).
