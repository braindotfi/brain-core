# Vendor Risk Scanner Payload Fields

`comparison.bank_on_file` is read from vendor counterparty metadata. `comparison.bank_on_invoice` is read from the latest invoice metadata for the same vendor. The scanner masks routing and account values before emitting context, and the proposal read model applies the same display-safe guard again. If either side has no bank metadata, that side is omitted.

## Decision Handler

The existing `approve` edit path now applies when the proposal has `comparison.bank_on_file` and `counterparty_id`. It writes the display-safe on-file routing metadata back to the vendor counterparty, updates any referenced payment intent to the on-file counterparty, marks the proposal `executed`, and emits `decision.executed` with outcome `routing_corrected`. Existing approve and reject behavior remains unchanged for vendor risk proposals without the edit payload.
