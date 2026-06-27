# @brain/surfaces

Deliver Brain agent proposals to Slack, Microsoft Teams, and email, then capture
approval decisions safely. One canonical proposal, three renderers, one shared
approval pipeline.

Brain analyzes. You decide. Your systems execute. This package owns "you decide".
It never moves funds.

## Package boundary

`@brain/surfaces` is intentionally one-way:

- It receives canonical proposals from Brain agents.
- It renders and dispatches those proposals to Slack, Teams, or email.
- It verifies inbound surface decisions at the edge.
- It resolves the click into Brain actor, policy, audit, idempotency, and
  execution ports supplied by `@brain/core`.

It does not import `@brain/core`; `pnpm run check-surface-acyclic` enforces that
boundary. Core owns storage, tenant scoping, policy, audit, and execution
handoff wiring.

## Quick shape

```ts
import {
  buildInvoiceProposal,
  SurfaceRegistry,
  SlackAdapter,
  Dispatcher,
  ApprovalService,
} from "@brain/surfaces";

// 1. an agent emits a proposal
const proposal = buildInvoiceProposal({
  /* finding from brain-core */
});

// 2. register the surfaces you run, then dispatch
const surfaces = new SurfaceRegistry().register(new SlackAdapter(slackClient));
const dispatcher = new Dispatcher(surfaces);
await dispatcher.dispatch(proposal, [{ surface: "slack", to: "C_AP_CHANNEL" }]);

// 3. on a button click or link, run the one pipeline
const approvals = new ApprovalService(brainCorePorts, surfaces, loadProposalById);
await approvals.handle(incomingDecision, deliveredRef);
```

`brainCorePorts` is supplied by brain-core and implements identity, policy,
audit, terminal-decision idempotency, and execution handoff. This package never
reaches past those ports.

## Inbound helpers

The package includes framework-neutral HTTP helpers:

- Slack: validates `X-Slack-Signature` and timestamp against the raw request
  body before parsing the interaction payload.
- Email: validates signed approval tokens before loading a proposal.
- Teams: accepts an injected Teams verifier so the deployable can bind the real
  Bot Framework verification path.

Each helper converts surface-native input into the same `IncomingDecision`
shape, then calls `ApprovalService.handle`.

## Decision safety

`ApprovalService.handle` keeps the money-path ordering explicit:

1. Expiry check.
2. Tenant-scoped identity resolution.
3. Click-time policy re-check.
4. Terminal-decision claim for idempotency.
5. Audit record.
6. Approval signature recording for approvals only.
7. Execution handoff for approvals only.
8. Best-effort surface update.

Duplicates return `already_decided` and do not enqueue execution again. Audit
still happens before any quorum-changing approval signature or execution
handoff.

See `SCOPE.md`, `CLAUDE.md`, and `CODEX_PROMPT.md`.

## Develop

```
pnpm install
pnpm --filter @brain/surfaces run lint
pnpm --filter @brain/surfaces run typecheck
pnpm --filter @brain/surfaces run test
```
