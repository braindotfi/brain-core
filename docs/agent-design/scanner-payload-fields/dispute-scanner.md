# Dispute Scanner Payload Fields

`historical_win_rate` is computed from prior tenant dispute obligations over the last 12 months. Cancelled prior disputes count as won outcomes, and paid prior disputes count as lost or refunded outcomes. The scanner emits percent, sample size, and `12m` only when the tenant has at least one prior closed dispute in that window.

## Decision Handlers

`fight` sends the proposal evidence bundle through `DisputeService.submit_evidence(dispute_id, evidence)` and records the submission reference in `decision.executed`.

`refund` sends `transaction_id`, `amount`, and the refund reason through `PaymentReversalService.refund`. Successful execution marks the proposal `executed` with outcome `refunded`.
