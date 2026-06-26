# CLAUDE.md (brain-core root)

Monorepo working notes. Keep current as work lands.

## Layout

Private workspace, UNLICENSED.

- `packages/surfaces` (@brain/surfaces): propose-only delivery and approval for
  the four public agents across Slack, Microsoft Teams, and email. Depends on
  nothing in core. Defines the four ports as interfaces.
- `packages/core` (@brain/core): implements those ports against brain-core's
  internal services and hosts the composition root. Depends on @brain/surfaces.

Dependency is one-directional and acyclic: core -> surfaces. A CI check should
fail the build if anything under packages/surfaces imports @brain/core.

## Branch

`feat/surface-adapters`. git fetch and pull before starting. This scaffold is
shaped to drop into the real brain-core repo: add the two packages to the
workspaces array and replace `packages/core/src/internal/services.ts` interfaces
with imports of the real internal services.

## Commands (from root)

- `pnpm --filter @brain/surfaces run typecheck`
- `pnpm --filter @brain/core run typecheck`
- `pnpm --filter @brain/surfaces run test`
- `pnpm --filter @brain/core run test`
- `pnpm run check-surface-acyclic`

Surfaces must be built before core typechecks when consuming the package export,
because core resolves @brain/surfaces through its built dist. The root scripts
include the packages in the workspace filters.

## Where the port implementations land

`packages/core/src/bindings/` holds the four bindings, one per port:

- `identity.ts` -> RLS-scoped tenant identity
- `policy.ts` -> the policy engine and the 23 gates
- `audit.ts` -> the immutable Audit log
- `execution.ts` -> the idempotent execution queue

`buildBrainCorePorts(services)` assembles them. `buildSurfaceRuntime` in
`packages/core/src/composition/` wires ports, adapters, dispatcher, and approval
service into the object the inbound webhook deployable boots.

## Status

Done

- Monorepo workspace with one-directional core -> surfaces dependency, verified.
- Surfaces package (schema, hashing, ports, dispatcher, approval pipeline, three
  adapters, four agent factories). Strict typecheck clean, 4 tests green.
- Core bindings for the surface ports, plus the composition root.
- End-to-end runtime test: dispatch to Slack then approve, with audit before
  execution. Green.
- Inbound helper layer: Slack signature verification before parsing, email token
  approval route, and Teams submit handler with injected activity verifier.
- Live transport client seams: Slack Web API client, Teams Bot Framework
  proactive client with conversation-reference store, and generic HTTP ESP
  client.
- Delivered-ref persistence from Dispatcher and terminal decision idempotency at
  the approval store boundary.
- Tests cover Slack signature valid, stale, and tampered; email token valid,
  expired, wrong-secret, and tampered; dual approval, double-click idempotency,
  and expired proposal clicks.

Pending (see packages/surfaces/CODEX_PROMPT.md for the full brief)

- [ ] Replace `internal/services.ts` interfaces with real brain-core services.
- [ ] Host the inbound helpers in the real webhook deployable and wire the Teams
      verifier to the Bot Framework adapter.
- [ ] Delivered-ref persistence and proposal load-by-id against real storage.
- [ ] Real agent input types from the detectors.
- [ ] CI: typecheck plus test gate, the acyclic-import check, and a lint step.
- [ ] Slack Marketplace MCP registry listing for the pull path.

## Runtime isolation

Run the surface webhook deployable as its own least-privilege process. The Slack,
Teams, and ESP credentials must not live in the core protocol service. Same repo,
separate deploy.

## Copy

No em dashes, no ampersands outside brand names, no emojis in docs, comments, or
commit messages.
