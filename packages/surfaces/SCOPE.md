# brain-surfaces: scope

Multi-surface delivery and approval for Brain's four public agents across Slack,
Microsoft Teams, and email. One canonical proposal object, three dumb renderers,
one shared approval pipeline.

"Brain analyzes. You decide. Your systems execute." This package owns the middle
step. It never moves funds.

## Architecture in one line

An agent emits a `Proposal`. The `Dispatcher` validates and hashes it once, then
fans it to the requested surfaces. A human acts on the rendered card. Every
decision, from any surface, runs the same `ApprovalService` pipeline: resolve
identity, re-check policy, anchor audit, record the approval signature, hand off
execution.

```
agent factory ──> Proposal ──> Dispatcher ──> SurfaceAdapter (slack | teams | email)
                                                     │
                                       human clicks Approve / Hold
                                                     │
                                                     v
                         ApprovalService:  identity -> policy -> audit -> signature -> handoff
                                                     │
                                                     v
                                  ExecutionHandoff (customer's own ERP / bank / ESP)
```

## What is built (compiles, typechecks strict, tests green)

- Canonical `Proposal` schema with zod validation and branded ids. The schema is
  the contract. Surfaces and agents never widen it ad hoc.
- Deterministic proposal hashing for the "proof of what was shown" audit anchor.
- Brain-core integration ports: `IdentityResolver`, `PolicyGate`,
  `AuditAnchor`, `ApprovalRecorder`, and `ExecutionHandoff`. Nothing else
  crosses the boundary, and no port can move money.
- `Dispatcher` (validate, hash, fan out) and `ApprovalService` (the one approval
  pipeline) with the security ordering enforced and tested.
- Three surface adapters with real render logic and injected transport clients:
  - Slack: Block Kit approval card, chat.postMessage push, stateless action_id
    encoding, interaction normalizer.
  - Teams: Adaptive Card 1.5, Bot Framework send, Action.Submit normalizer.
  - Email: signed one-time token, HTML template with approve and hold links,
    hosted approval route decoder.
- Four agent proposal factories: Invoice, Collections, Cash, Close.
- Config loader that fails fast on missing secrets.
- Tests covering hash determinism, dispatch, policy denial, audit-before-sign,
  and audit-before-handoff.

## What is stubbed for the implementer (see CODEX_PROMPT.md)

- The brain-core port implementations. This package defines the interfaces. The
  bindings (real RLS-scoped identity, the 23 policy gates, the Audit writer, the
  execution queue) live in brain-core.
- Live transport wiring: @slack/bolt or @slack/web-api, Bot Framework adapter,
  the ESP client, and the two inbound HTTP routes (Slack interactivity, email
  approval) with signature and token verification at the edge.
- Persistence of delivered message refs so terminal decisions can update the
  original card, and proposal load-by-id for `ApprovalService`.
- The agent input types are placeholders. Bind them to the real detector outputs
  from brain-core. Read monetary values from source records, never synthesize.

## Non-negotiable invariants (do not regress)

1. A decision is never signed or executed before it is audited. Audit comes
   before approval signature recording and handoff. The tests
   `audits before it ever hands off` and
   `records awaiting approval signatures after audit` guard this.
2. Authority is re-checked at click time by the Policy gate, not trusted from the
   rendered card. A surface can never become a policy-bypass path.
3. Identity resolves to a tenant-scoped Brain actor. No workspace-level trust.
4. Brain proposes. Execution always leaves Brain through `ExecutionHandoff` to a
   customer rail. Never wire a surface button straight to a money movement.
5. The proposal content hash captured at emit time is what the audit record
   proves. Do not recompute it at decision time.

## Surface notes

- Slack: pair this push app with a Slack Marketplace MCP registry listing so
  Slackbot can also pull proposals. Push (this package) is the revenue surface;
  pull reuses Brain's existing MCP server.
- Teams: same proposal, Adaptive Cards instead of Block Kit. Covers mid-market
  finance teams not on Slack.
- Email: weakest UX, widest reach. Works for teams on no chat platform.

## Sequencing

1. Slack push first. Pairs with the Invoice Agent duplicate-catch, the day-one
   provable outcome and the cleanest demo.
2. Teams second. Same adapter shape.
3. Email third for universal reach.
4. ERP-embedded later, tied to a design partner already on NetSuite.
