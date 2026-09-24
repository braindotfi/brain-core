# Fraud Anomaly Scanner Payload Fields

`signals.geo_mismatch` comes from the current transaction counterparty metadata region or country compared with distinct regions or countries seen for the same account over the prior 90 days. `signals.off_hours` compares the current UTC transaction hour with the min and max UTC activity hours in that 90 day account history. `signals.normal_vs_current` uses the same 90 day window for average amount, typical hour range, typical counterparty type, and observed geography. If counterparty metadata or history is missing, the scanner omits the unavailable signal.

## Decision Handler

`freeze_card` executes through `CardIssuer.freeze(card_id)` and `DisputeService.file(transaction_id, reason)`. The default adapters are in memory. Stripe Issuing, Marqeta, and First Meridian adapters are represented as TODO stubs in the shared adapter surface. Successful execution marks the proposal `executed` with outcome `frozen` and emits `decision.executed` with outbound references.
