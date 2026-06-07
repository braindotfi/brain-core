# ADR 0008: Demo and production are strictly separated

- Status: Accepted
- Date: 2026-06-07

## Context

Demos need seed data, stub rails, and shortcuts. Production must have none of
them. The classic failure is a stub or seed path that was "only for the demo"
quietly running in production, either fabricating a settlement that never
happened or planting demo tenants in a real environment. A stub rail that
returns success without moving money is especially dangerous: it makes a 100%
failure look like a 100% success.

## Decision

Demo and stub machinery fails closed in production rather than relying on
configuration discipline. The stub rails and `erp_writeback` throw under
`NODE_ENV=production` (both `defaultRails()` and each dispatch). Demo
provisioning is blocked by a boot fence in production. A separate boot fence
refuses to start production if zero live rails would register, so a
misconfiguration surfaces as CrashLoopBackoff (loudly) instead of a silent wave
of fake or failed payments.

## Consequences

- A stub can never fake a settlement in production: the path throws.
- A misconfigured production environment refuses to boot rather than running in a
  dangerous half-state.
- Demos remain fully featured against the dev stack; the separation cost is borne
  by configuration, not by the safety model.

## Enforced by

- `services/execution/src/rails/stubs.ts`: fails closed under `NODE_ENV=production`.
- `services/api/src/composition/rails-prod-fence.ts`: no-live-rails refusal.
- `services/api/src/composition/demo-provision-fence.ts`: demo-in-prod refusal.
