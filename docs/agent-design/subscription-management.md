# Subscription Management Agent Design

## Purpose

`subscription_management` extends the existing subscription detection work into
seat-level SaaS intelligence. The current `subscription` agent detects recurring
charges, price changes, and duplicates. This agent adds directory and SSO
signals so Brain can compare paid seats with actual usage, find newly
provisioned seats, and recommend commercial actions.

## Triggers

| Trigger                            | Meaning                                                           | Default action |
| ---------------------------------- | ----------------------------------------------------------------- | -------------- |
| `subscription.seats_underutilized` | Active usage is below a configurable licensed-seat threshold.     | `downgrade`    |
| `subscription.new_signup_detected` | A user was provisioned a SaaS seat through SSO or directory feed. | `renew`        |

The scanner should consume normalized directory feed rows from providers such as
Okta, Google Workspace, and Microsoft Entra after connector ingestion lands.
It also subscribes to `recurring_charge.detected`, `vendor.duplicate_detected`,
and `subscription.price_changed` so recurring subscription proposals can route
to this workflow when a tenant has scoped the capability and evidence supports
the management rail.

## Payload

The proposal payload is stored in `details` on the proposal read model.

Required fields:

| Field                | Type           | Notes                                                      |
| -------------------- | -------------- | ---------------------------------------------------------- |
| `subscription_id`    | string         | Internal subscription or recurring-charge id.              |
| `merchant`           | string         | SaaS vendor display name.                                  |
| `current_plan`       | string         | Current plan or contract label.                            |
| `renewal_date`       | string or null | Renewal date when known.                                   |
| `currency`           | string         | ISO currency.                                              |
| `current_price`      | string         | Current recurring price.                                   |
| `seats`              | object         | Licensed seats, active 30-day users, and active user rows. |
| `underutilization`   | object         | Percent unused and dollar value.                           |
| `options`            | array          | Downgrade, renegotiate, cancel, or renew options.          |
| `recommended_action` | enum           | `downgrade`, `renegotiate`, `cancel`, or `renew`.          |

## Decisions

| Decision      | Behavior                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `downgrade`   | Drop to the recommended seat count. Include mid-term proration only when supported by the provider. |
| `renegotiate` | Draft outreach email to vendor sales with utilization and savings data.                             |
| `cancel`      | End subscription at renewal.                                                                        |
| `renew`       | Accept current or new terms.                                                                        |

The current proposal decision API only accepts `approve`, `reject`,
`acknowledge`, and `undo`. The Inbox should map the selected domain decision to
`approve` with the selected option captured in proposal details until
domain-specific proposal decisions are added. `reject` should leave the
subscription unchanged.

## Policy Authority

Default authority is `propose`. The agent does not change vendor plans, send
vendor messages, or cancel services without a human decision.

Renewals may be auto-approved by a policy template only when the proposed action
is `renew`, annual price is below USD 500, and explicit pricing evidence shows
no price change. Runtime code records `auto_approval_eligible` metadata when
those facts are present, but approval behavior remains owned by policy.

Approval authority should require an active tenant member with admin or approver
role for procurement, SaaS, or treasury domains. If a downgrade or cancellation
affects a critical app, policy should require a second approval.

## Dry-Run Rules

1. Scanner output may create proposals only through `AgentRunService`.
2. Directory feed data is evidence, not authority. It cannot create or remove
   seats directly.
3. A downgrade option is valid only when `active_30d` is lower than licensed
   seats by the configured threshold.
4. Savings must be derived from current price and option price, not model text.
5. Provider proration support must be explicit. Unknown support defaults to no
   mid-term proration.
6. New signup detection must be idempotent per app, user, tenant, and provision
   event.

## Runtime Wiring

`subscription_management` is registered in the internal-agent catalog and its
handler builds agent-channel proposals for `downgrade`, `renegotiate`, `cancel`,
and `renew`. The seat-usage scanner uses a `DirectoryProvider` adapter from
`@brain/shared`. The default `NoneDirectoryProvider` emits no rows, so no seat
proposal is fabricated when SSO data is absent. Okta, Google Workspace, and
Microsoft Entra are represented by TODO adapter stubs.

The handler includes decision-effect metadata for the human-approved downstream
workflow. `SaaSVendorApi` is defined in `@brain/shared`, with a stub result for
providers that do not support direct plan changes.

## Emit Gaps

`subscription.seats_underutilized` is emitted by the scanner when a configured
directory provider returns licensed and active usage below the threshold.
`subscription.new_signup_detected` is in the routing vocabulary, and the
directory provider TODO stub marks that concrete SSO adapters should emit it
when connector feed rows exist.

## Runtime Files

| File                                                                 | Purpose                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `services/internal-agents/src/subscription_management/definition.ts` | Agent definition and event routing metadata.                      |
| `services/internal-agents/src/subscription_management/payload.ts`    | Payload TypeScript types.                                         |
| `services/internal-agents/src/subscription_management/handler.ts`    | Proposal builder for renewal and vendor-management decisions.     |
| `services/api/src/agents/subscription-management-scanner.ts`         | Polling scanner that reads recurring charges and directory usage. |
| `shared/src/adapters/subscription.ts`                                | Directory and vendor API adapter interfaces with default stubs.   |
