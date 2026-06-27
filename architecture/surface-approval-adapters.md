# Surface Approval Adapters

Brain surface adapters deliver agent proposals to the places where operators already work: Slack, Microsoft Teams, and email. They are approval surfaces, not execution rails.

## Current Code

The implementation lives in `packages/surfaces`, core bindings live in
`packages/core`, and the inbound webhook process lives in
`services/surface-gateway`.

| Area                        | Location                                   | Responsibility                                                                  |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Proposal schema and hashing | `packages/surfaces/src/proposal`           | Canonical proposal validation and content hash generation                       |
| Dispatch pipeline           | `packages/surfaces/src/core/dispatcher.ts` | Validate, hash once, deliver, and persist delivered refs through a callback     |
| Approval pipeline           | `packages/surfaces/src/core/approval.ts`   | Expiry, identity, policy, idempotency, audit, execution handoff, surface update |
| Surface renderers           | `packages/surfaces/src/surfaces`           | Slack Block Kit, Teams Adaptive Cards, and email templates                      |
| Inbound helpers             | `packages/surfaces/src/http`               | Slack signature validation, email token validation, Teams verifier seam         |
| Live clients                | `packages/surfaces/src/clients`            | Slack Web API, generic HTTP email provider, and Bot Framework Teams client      |
| Core bindings               | `packages/core/src/bindings`               | Adapter layer from Brain services into surface ports                            |
| Webhook deployable          | `services/surface-gateway`                 | Fastify routes, DB adapters, live client wiring, and process isolation          |

`@brain/surfaces` does not import `@brain/core`. The root `check-surface-acyclic` script enforces the dependency direction.

## Runtime Flow

```
Agent finding
  -> Proposal factory
  -> Dispatcher
  -> Slack, Teams, or email adapter
  -> Human approve or hold action
  -> Inbound HTTP helper
  -> ApprovalService.handle
  -> @brain/core ports
  -> execution approval handoff
```

The dispatcher computes the proposal content hash once at emit time. That hash is the value later recorded in audit, so the audit record proves what was shown to the approver.

## Approval Safety Model

All surfaces share the same approval pipeline:

1. Reject expired proposals.
2. Resolve the surface identity to a tenant-scoped Brain actor.
3. Re-check authority at click time through policy.
4. Claim the terminal decision so duplicate clicks cannot enqueue twice.
5. Write audit before anything leaves Brain.
6. Enqueue execution only for approved proposals.
7. Update the original surface message on a best-effort basis.

Slack, Teams, and email are therefore input channels to the same policy and audit path. A surface button cannot become a direct money movement path.

## Deployment Notes

`services/surface-gateway` hosts the framework-neutral handlers as a separate
Fastify v5 process:

| Route                               | Purpose                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `POST /surfaces/slack/interactions` | Slack interactivity with raw-body signature verification and retry dedupe |
| `GET /surfaces/email/approve`       | Confirmation page for signed email approval links                         |
| `HEAD /surfaces/email/approve`      | Link preview and health-safe email route check                            |
| `POST /surfaces/email/approve`      | Email approval confirmation with signed-token validation                  |
| `POST /surfaces/teams/messages`     | Bot Framework verified Teams submit activities                            |
| `POST /surfaces/smoke/proposals`    | Explicitly gated smoke dispatch for release candidates                    |
| `GET /healthz`                      | Process health check                                                      |

The gateway owns only surface persistence:

- `surface_external_identities`
- `surface_proposals`
- `surface_delivered_refs`
- `surface_decisions`
- `surface_slack_retries`
- `surface_teams_conversation_refs`

The production DB role is `brain_surface_gateway`. It is tenant-scoped, has no
`BYPASSRLS`, and has no Ledger or execution outbox grants. Decisions delegate to
the active Policy document at click time, write shared Audit with deterministic
idempotency keys, and use the existing execution approval path for handoff.
