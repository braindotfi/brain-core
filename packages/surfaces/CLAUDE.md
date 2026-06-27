# CLAUDE.md

Working notes for the brain-surfaces package. Keep current as work lands.

## What this is

Multi-surface delivery and approval for Brain's four public agents (Invoice,
Collections, Cash, Close) across Slack, Microsoft Teams, and email. Propose-only.
Never moves funds. See SCOPE.md for the full picture and CODEX_PROMPT.md for the
implementation brief.

## Placement

Lives at `packages/surfaces` in the brain-core monorepo. Depends on nothing in
core. The four ports defined in `src/core/ports.ts` are implemented by
`@brain/core` under `packages/core/src/bindings`. Dependency direction is
core -> surfaces, never the reverse. See the root CLAUDE.md.

## Branch

`fix/surface-approval-hardening`. Branch from latest `origin/main`, keep this
file and the root CLAUDE.md updated as tasks move.

## Layout

- `src/proposal` canonical schema and hashing. The contract.
- `src/core` ports (brain-core boundary), dispatcher, approval pipeline, registry.
- `src/surfaces/{slack,teams,email}` adapters, card builders, decision normalizers.
- `src/agents` one proposal factory per public agent.
- `src/config` env loader.
- `test` schema, dispatch, and approval-pipeline invariants.

## Commands

- `pnpm --filter @brain/surfaces run typecheck` strict, must stay at zero
  errors.
- `pnpm --filter @brain/surfaces run test` node test runner via tsx.
- `pnpm --filter @brain/surfaces run build` emits to dist.
- `pnpm lint` runs the full repo gate before PR.

## Status

Done

- Canonical Proposal schema, zod validated, branded ids.
- Deterministic content hash for audit anchoring.
- Ports: IdentityResolver, PolicyGate, AuditAnchor, ExecutionHandoff.
- Dispatcher and ApprovalService with enforced security ordering.
- Slack, Teams, email adapters with pure card builders and injected clients.
- Four agent factories.
- Config loader. Tests green. Strict typecheck clean.
- Slack signature verification before parsing, email confirmation plus POST
  approval route, and Teams submit handler.
- Slack Web API client, Teams Bot Framework proactive client with
  conversation-reference store, Bot Framework activity verifier, and generic
  HTTP ESP client.
- Delivered-ref persistence from Dispatcher and terminal decision idempotency at
  the approval store boundary, including crash-safe unapplied replay.
- Slack outcomes are posted through `response_url`; background approval errors
  are caught and logged.
- Tests cover Slack signature valid, stale, tampered, ack timing, outcome
  posting, and logged failures; email GET and HEAD confirmation, POST approval,
  missing and invalid tokens; dual approval, double-click idempotency, crash-safe
  replay, and expired proposal clicks.

Pending (for the implementer)

- [ ] brain-core port bindings (real identity, 23 policy gates, audit, execution).
- [ ] Host the inbound helpers in the real webhook deployable.
- [ ] Delivered-ref persistence and proposal load-by-id against real storage.
- [ ] Replace placeholder agent input types with real detector outputs.
- [ ] Slack Marketplace MCP registry listing for the pull path.

## Invariants (never regress)

Audit before handoff. Policy re-check at click time. Tenant-scoped identity, no
workspace-level trust. Execution always leaves Brain via ExecutionHandoff. The
emit-time content hash is the audit truth.

## Copy

No em dashes, no ampersands outside brand names, no emojis in docs and comments.
Slack mrkdwn uses Slack's own emoji shortcodes in card banners, which is surface
markup, not prose.
