# Proposal Rail Fields

## Purpose

RobotMoney Inbox rails need richer proposal payloads while preserving the existing approval contract. This design adds optional read-model fields to `/v1/proposals/{id}` and the proposal list response. The fields are copied from stored proposal details only when present, so existing clients keep receiving the current shape.

## OpenAPI Diff

`ProposalType` now includes `invoice_integrity`. `AgentOutputProposal` has optional rail fields for fraud signals, vendor bank comparison, dispute win rates, treasury allocation state, reconciliation close aggregates, cash forecast drivers, revenue concentration, and invoice integrity review data. `available_decisions` and the optional `decisions` array can carry executable domain decisions such as `freeze_card`, `fight`, `refund`, `confirm_all_matches`, and `hold_and_verify`.

## Type Surface

The new `@brain/proposals` package owns the reusable TypeScript payload types. `services/execution` imports those types for the proposal read model, `clients/sdk/src/generated/openapi.d.ts` mirrors the OpenAPI additions, and the surface proposal adapter accepts the same optional rail payload under `inbox`.

## Agent Notes

`fraud_anomaly` now exposes `signals.geo_mismatch`, `signals.off_hours`, and `signals.normal_vs_current` when those values are present in stored details. The UI can show the observed geography, hour, and behavioral baseline without inferring fraud context from generic details. It also receives `freeze_card` as a domain decision in the optional `decisions` array.

`vendor_risk` now exposes `comparison.bank_on_file` and `comparison.bank_on_invoice` with bank name, masked routing, masked account, and beneficiary values. These fields are display safe by contract and must never carry full account numbers.

`dispute` now exposes `historical_win_rate` with percent, sample size, and time window. The optional `decisions` array includes the existing domain choices plus `fight` and `refund`, without changing the canonical approve or reject semantics.

`treasury` now exposes `allocation_before`, `allocation_after`, `safety_meter`, and `estimated_annual_yield_gain`. The UI can render liquidity movement, floor and ceiling context, and expected yield impact without touching PaymentIntent or policy behavior.

`reconciliation` now exposes `close_aggregate` with the close period, match counts, totals, and drift. The optional domain decisions add `confirm_all_matches` and `escalate_to_accountant` for Inbox rendering only.

`cash_forecast` now accepts `horizon_days` of 180 or more and can include `drivers` plus `runway_projection`. This lets the Inbox rail show the forecast period, named inflow or outflow drivers, and projected balance path.

`revenue_intel` now exposes `concentration`, `historical_concentration`, and `pipeline_coverage`. The UI can show current customer concentration, the trend by period, and coverage against the quarter plan.

`invoice_integrity` is promoted to the public proposal type contract. Its payload includes `flagged_invoice`, `suspected_original`, `match_confidence`, and `finding_kind`, with executable domain decisions `approve_as_new`, `reject_duplicate`, and `hold_and_verify`.

## Migration Note

All new fields are optional and additive. Existing clients remain unaffected, approval authority continues to run through the current policy path, and domain decisions are additive decision ids on the same decide endpoint.
