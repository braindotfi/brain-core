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

`feat/surface-adapters`. git fetch and pull before starting, keep this file and
the root CLAUDE.md updated as tasks move.

## Layout

- `src/proposal` canonical schema and hashing. The contract.
- `src/core` ports (brain-core boundary), dispatcher, approval pipeline, registry.
- `src/surfaces/{slack,teams,email}` adapters, card builders, decision normalizers.
- `src/agents` one proposal factory per public agent.
- `src/config` env loader.
- `test` schema, dispatch, and approval-pipeline invariants.

## Commands

- `npm run typecheck` strict, must stay at zero errors.
- `npm test` node test runner via tsx.
- `npm run build` emits to dist.

## Status

Done

- Canonical Proposal schema, zod validated, branded ids.
- Deterministic content hash for audit anchoring.
- Ports: IdentityResolver, PolicyGate, AuditAnchor, ExecutionHandoff.
- Dispatcher and ApprovalService with enforced security ordering.
- Slack, Teams, email adapters with pure card builders and injected clients.
- Four agent factories.
- Config loader. Tests green. Strict typecheck clean.
- Slack signature verification before parsing, email token approval route, and
  Teams submit handler with injected activity verifier.
- Slack Web API client, Teams Bot Framework proactive client with
  conversation-reference store, and generic HTTP ESP client.
- Delivered-ref persistence from Dispatcher and terminal decision idempotency at
  the approval store boundary.
- Tests cover Slack signature valid, stale, and tampered; email token valid,
  expired, wrong-secret, and tampered; dual approval, double-click idempotency,
  and expired proposal clicks.

Pending (for the implementer)

- [ ] brain-core port bindings (real identity, 23 policy gates, audit, execution).
- [ ] Host the inbound helpers in the real webhook deployable and wire the Teams
      verifier to the Bot Framework adapter.
- [ ] Delivered-ref persistence and proposal load-by-id against real storage.
- [ ] Replace placeholder agent input types with real detector outputs.
- [ ] Slack Marketplace MCP registry listing for the pull path.
- [ ] CI: typecheck plus test gate; add a lint step.

## Invariants (never regress)

Audit before handoff. Policy re-check at click time. Tenant-scoped identity, no
workspace-level trust. Execution always leaves Brain via ExecutionHandoff. The
emit-time content hash is the audit truth.

## Copy

No em dashes, no ampersands outside brand names, no emojis in docs and comments.
Slack mrkdwn uses Slack's own emoji shortcodes in card banners, which is surface
markup, not prose.
