# ADR 0001: PaymentIntent is the only money path

- Status: Accepted
- Date: 2026-06-07

## Context

A financial protocol with many services, rails, and agents has many places that
could plausibly move money. If even one of them dispatches a rail directly, the
deterministic safety guarantees (policy, evidence, approvals, audit) become
"usually applied" rather than "always applied". For an autonomous-agent system,
"usually" is a liability, not a feature.

## Decision

All money movement flows through exactly one method: `PaymentIntentService.execute`.
Both `POST /payment-intents/{id}/execute` and `POST /actions/{id}/execute` route
through it. That method, and only that method, runs the §6 gate and then
dispatches a rail. No service, worker, or agent dispatches a rail or transitions
a record to `executed` on its own.

## Consequences

- There is a single place to audit, instrument, and reason about for "can money
  move incorrectly here?".
- New rails plug into the registry behind the same choke point; they do not get
  their own execution path.
- The §6 gate (ADR 0003) and the audit-before/after pair are unavoidable: they
  are inside the one path everything funnels through.
- The cost is indirection: callers cannot "just send a payment". That is the
  point.

## Enforced by

- `scripts/check-gate-bypass.mjs` (wired into `pnpm run lint`): fails the build
  if any rail dispatch or transition to `executed` occurs outside
  `PaymentIntentService`.
- `services/execution/src/payment-intents/PaymentIntentService.ts`: the single
  `execute()` choke point.
- The money-movement E2E (`scripts/demo/golden-path.sh`, `tests/e2e/`) exercises
  the path end-to-end on every PR.
