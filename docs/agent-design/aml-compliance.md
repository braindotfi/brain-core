# AML Compliance Agent Design

## Purpose

`aml_compliance` handles AML, KYC, OFAC, PEP, and payment-specific regulatory
obligations for individual outbound payments. It is separate from the existing
`compliance` agent, which handles policy, approval, and audit findings after
Brain policy decisions or audit events exist.

The agent produces an Inbox proposal before a payment can release when a wire
crosses jurisdictions, exceeds a local reporting threshold, has stale
beneficiary KYC, or needs retro screening after a list update.

## Triggers

| Trigger                              | Meaning                                                                          | Default action |
| ------------------------------------ | -------------------------------------------------------------------------------- | -------------- |
| `payment.cross_border_created`       | Outbound payment crosses jurisdictions.                                          | `hold`         |
| `payment.above_regulatory_threshold` | Payment exceeds a jurisdiction threshold. Examples: UAE AED 55000, US USD 10000. | `hold`         |
| `kyc.beneficiary_stale`              | Beneficiary KYC is older than 12 months.                                         | `provide_docs` |
| `ofac.list_updated`                  | Retro screening is required for active vendors.                                  | `hold`         |

## Payload

The proposal payload is stored in `details` on the proposal read model.

Required fields:

| Field                    | Type         | Notes                                                                 |
| ------------------------ | ------------ | --------------------------------------------------------------------- |
| `payment_id`             | string       | Canonical payment or payment intent id.                               |
| `beneficiary_id`         | string       | Ledger counterparty or beneficiary id.                                |
| `amount`                 | string       | Decimal amount.                                                       |
| `currency`               | string       | ISO currency or supported token code.                                 |
| `jurisdictions_involved` | string array | Sender, beneficiary, intermediary, and rail jurisdictions when known. |
| `screenings`             | object       | OFAC, PEP, and KYC freshness results.                                 |
| `required_documents`     | array        | Document checklist with `cleared`, `needed`, or `pending` status.     |
| `regulatory_context`     | object       | Jurisdiction, regulation id, threshold, and purpose-code requirement. |
| `recommended_action`     | enum         | `provide_docs`, `delegate`, or `hold`.                                |
| `deadline`               | string       | ISO8601 timestamp.                                                    |

## Decisions

| Decision   | Behavior                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `provide`  | Documents have been uploaded or confirmed. The payment may continue through the existing gate. |
| `delegate` | Send the document checklist to another user and keep the payment pending.                      |
| `hold`     | Pause the payment and re-notify the next day.                                                  |

The current proposal decision API only accepts `approve`, `reject`,
`acknowledge`, and `undo`. The Inbox should map these domain decisions to the
canonical proposal decision route until domain-specific decisions are added:

| Domain decision | Canonical decision | Notes                                              |
| --------------- | ------------------ | -------------------------------------------------- |
| `provide`       | `approve`          | Requires uploaded evidence before approval.        |
| `delegate`      | `approve`          | Approves delegation workflow, not payment release. |
| `hold`          | `reject`           | Keeps or moves payment into held state.            |

## Policy Authority

Default authority should be `propose`. The agent never executes or releases a
payment directly.

Approval authority should require an active tenant member with payment approval
authority for the payment domain. For regulated payments, policy should require
the actor to be an admin or approver and should preserve any tenant-wide second
approval rule. Agent principals remain propose-only.

## Dry-Run Rules

1. Scanner output may create proposals only through `AgentRunService`.
2. The handler must not call payment release or rail dispatch.
3. Missing OFAC, PEP, KYC, or regulatory context evidence must fail closed to
   `hold` or `notify_only`.
4. If a required document is `needed` or `pending`, the payment remains blocked.
5. If any screening status is `match` or `possible_match`, the recommendation is
   `hold`.
6. Retro screening after `ofac.list_updated` must be idempotent per beneficiary,
   list version, and tenant.

## Runtime Wiring

`aml_compliance` is registered in the internal-agent catalog and its handler now
builds agent-channel proposals for `provide_docs`, `delegate`, and `hold`. The
scanner reads wire PaymentIntent rows from Ledger, uses `OfacScreener`,
`PepScreener`, and `KycStore` adapters from `@brain/shared`, and defaults to
in-memory OFAC and PEP clear stubs plus an unwired KYC store that marks
freshness stale with `kyc_store_not_wired`.

Jurisdiction thresholds and document rules are held in
`services/api/src/agents/config/jurisdictions.json`, with the typed scanner copy
in `aml-compliance-config.ts`.

## Emit Gaps

`payment.cross_border_created` and `payment.above_regulatory_threshold` are in
the routing vocabulary. `PaymentIntentService.create` has a TODO at the creation
site because payment intents do not yet carry explicit source and beneficiary
jurisdictions.

`kyc.beneficiary_stale` is emitted by the scanner while the tenant KYC store is
unwired. `ofac.list_updated` is registered in the routing vocabulary, but there
is no OFAC list ingestion owner yet, so retro screening starts from scanner
polling only.

## Runtime Files

| File                                                        | Purpose                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `services/internal-agents/src/aml_compliance/definition.ts` | Agent definition and event routing metadata.                    |
| `services/internal-agents/src/aml_compliance/payload.ts`    | Payload TypeScript types.                                       |
| `services/internal-agents/src/aml_compliance/handler.ts`    | Proposal builder for document, delegation, and hold decisions.  |
| `services/api/src/agents/aml-compliance-scanner.ts`         | Polling scanner that reads wires and adapter screening results. |
| `shared/src/adapters/aml.ts`                                | OFAC, PEP, and KYC adapter interfaces with default stubs.       |
