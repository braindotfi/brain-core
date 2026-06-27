# Surface Approval Adapters

Brain surface adapters deliver agent proposals to the places where operators already work: Slack, Microsoft Teams, and email. They are approval surfaces, not execution rails.

## Current Code

The implementation lives in `packages/surfaces` with core bindings in `packages/core`.

| Area                        | Location                                   | Responsibility                                                                  |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| Proposal schema and hashing | `packages/surfaces/src/proposal`           | Canonical proposal validation and content hash generation                       |
| Dispatch pipeline           | `packages/surfaces/src/core/dispatcher.ts` | Validate, hash once, deliver, and persist delivered refs through a callback     |
| Approval pipeline           | `packages/surfaces/src/core/approval.ts`   | Expiry, identity, policy, idempotency, audit, execution handoff, surface update |
| Surface renderers           | `packages/surfaces/src/surfaces`           | Slack Block Kit, Teams Adaptive Cards, and email templates                      |
| Inbound helpers             | `packages/surfaces/src/http`               | Slack signature validation, email token validation, Teams verifier seam         |
| Live clients                | `packages/surfaces/src/clients`            | Slack Web API, generic HTTP email provider, and Bot Framework Teams client      |
| Core bindings               | `packages/core/src/bindings`               | Adapter layer from Brain services into surface ports                            |

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
  -> ExecutionHandoff enqueue
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

The package provides framework-neutral handlers. A production deployable still needs to host those handlers behind the real API edge:

- Slack interactivity endpoint with raw-body preservation.
- Teams bot endpoint with Bot Framework verification.
- Email approval endpoint with HTTPS-only signed token links.
- Persistent proposal storage and delivered-message refs in Brain core storage.
- A real `ApprovalDecisionStore` backed by an atomic tenant/proposal uniqueness constraint.
