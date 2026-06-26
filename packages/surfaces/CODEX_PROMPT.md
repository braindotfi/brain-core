# Codex implementation prompt: brain-surfaces

Paste this into Codex with the `brain-surfaces` package in context. The scaffold
compiles, typechecks under strict mode, and has green tests. Your job is to
implement the stubbed parts into a production-ready integration without breaking
the invariants below.

---

## Context

You are extending `@brain/surfaces`, a propose-only delivery and approval layer
for Brain's four public agents (Invoice, Collections, Cash, Close) across Slack,
Microsoft Teams, and email. Brain analyzes, the human decides on the rendered
card, and the customer's own systems execute. This package must never move funds.

Read `SCOPE.md` and `CLAUDE.md` first. Treat `src/proposal/schema.ts` as the
contract: do not change the proposal shape to suit a surface or an agent.

## Hard invariants (a change that breaks any of these is wrong)

1. In `ApprovalService.handle`, the order is fixed: expiry, identity, policy,
   audit, then execution handoff. Audit (step 4) must complete before execution
   (step 5). Never reorder. The test `audits before it ever hands off` guards it.
2. Authority is re-checked at click time through `PolicyGate.canDecide`. Never
   trust the rendered card or the email token as proof of authority on their own.
3. Identity always resolves to a tenant-scoped Brain actor via `IdentityResolver`.
   No workspace-level or domain-level trust.
4. Execution always leaves Brain through `ExecutionHandoff.enqueue`. Never call a
   bank, ERP, or send API directly from this package, and never wire a surface
   button to a money movement.
5. The content hash is computed once at emit time (`withContentHash` in the
   `Dispatcher`) and is the audit truth. Do not recompute at decision time.

If a requested feature appears to require breaking one of these, stop and surface
the conflict instead of working around it.

## Tasks

### 1. Inbound HTTP routes with edge verification

- Slack interactivity endpoint. Verify the Slack request signature
  (`X-Slack-Signature`, `X-Slack-Request-Timestamp`, HMAC over the raw body with
  the signing secret, reject if older than five minutes) BEFORE parsing. Then use
  `toIncomingDecision` from `src/surfaces/slack/interactions.ts` and pass the
  result to `ApprovalService.handle`. Respond within three seconds, ack first.
- Email approval route (`GET` at `EMAIL_APPROVAL_BASE_URL`). Read the `t` query
  param, call `toIncomingDecision` from `src/surfaces/email/adapter.ts`, run the
  pipeline, and render a plain outcome page (approved, held, expired, denied,
  unknown). The token proves link integrity only. Policy still decides authority.
- Teams messaging endpoint behind the Bot Framework adapter. Authenticate the
  activity, extract the verified aad object id and the Action.Submit data, call
  `toIncomingDecision` from `src/surfaces/teams/adapter.ts`, run the pipeline.

### 2. Transport clients (implement the injected interfaces)

- `SlackClient` using `@slack/web-api` WebClient (`chat.postMessage`,
  `chat.update`). Build the push app with `@slack/bolt` if convenient, but keep
  the `SlackClient` interface as the seam so card builders stay unit-testable.
- `TeamsClient` using `botbuilder`. Implement proactive messaging: persist a
  `ConversationReference` per target at install or first contact, keyed by the
  `to` value the dispatcher passes, and use `continueConversation` to send.
- `EmailClient` against the chosen ESP. HTML and text are pre-rendered by
  `renderEmail`; you only send.

### 3. brain-core port bindings

Implement `IdentityResolver`, `PolicyGate`, `AuditAnchor`, `ExecutionHandoff`
against brain-core. These likely live in brain-core and import this package's
interfaces. Requirements:

- `IdentityResolver.resolve` is RLS- and tenant-scoped. Map Slack user id, Teams
  aad object id, and verified email to the same Brain actor where the customer
  has linked them.
- `PolicyGate.canDecide` runs the real gates, honors `requiresDualApproval`, and
  returns `awaitingSecondApproval` when a first valid approval is recorded but a
  second is still needed.
- `AuditAnchor.record` writes an immutable row including `contentHash`, actor,
  surface, decision, and timestamp.
- `ExecutionHandoff.enqueue` places the approved proposal on the execution queue.
  It must be idempotent on proposal id so a double click cannot double-execute.

### 4. Persistence

- Store the delivered message ref (Slack ts, Teams activity id) keyed by
  proposal id and target, so `updateDecision` can edit the original card.
- Implement `loadProposal({ tenantId, proposalId })` for `ApprovalService`,
  reading the canonical proposal that was dispatched. It must return the exact
  object that was hashed, including `contentHash`.

### 5. Agent inputs

Replace the placeholder `*Finding` input types in `src/agents/*` with the real
detector output types from brain-core and map every field. Read monetary amounts
from source records. Never synthesize values. Keep the factory output passing
`ProposalSchema.parse`.

### 6. Idempotency and races

A proposal can be clicked twice, or in Slack and email both. The first terminal
decision wins. Subsequent decisions return a clear already-decided outcome and do
not re-audit or re-enqueue. Enforce at the store and in `ExecutionHandoff`.

### 7. Tests

Add tests for: Slack signature verification (valid, stale, tampered), email token
verification (valid, expired, wrong secret, tampered), dual-approval flow,
double-click idempotency, and an expired-proposal click. Keep the existing tests
passing.

## Definition of done

- `npm run typecheck` zero errors under the existing strict tsconfig. Do not relax
  `strict`, `noUncheckedIndexedAccess`, or `exactOptionalPropertyTypes`.
- `npm test` green, including the new tests.
- No secret hardcoded. All config flows through `loadConfig`.
- No new dependency that can move money or call a financial rail from this package.
- Update `CLAUDE.md` Status section: move completed items from Pending to Done.

## House style

No em dashes, no ampersands outside brand names, no emojis in comments, docs, or
commit messages. Slack mrkdwn emoji shortcodes inside card banners are surface
markup and are fine. Prefer const objects with `as const` over enums. Explicit
return types on public functions. No `any` without a written justification.

## Working method

Work on the `feat/surface-adapters` branch. git fetch and pull before starting.
Commit in small, reviewable steps. After each task, run typecheck and tests
before moving on.
