# Invoice Integrity Scanner Payload Fields

`flagged_invoice`, `suspected_original`, `match_confidence`, and `finding_kind` are copied from the scanner payload when present. The values describe the invoice under review, the suspected original invoice, the confidence signals, and the finding class.

## Decision Handlers

`approve_as_new` records the invoice integrity decision on the invoice or obligation projection and emits `decision.executed` with outcome `invoice_approved` plus `invoice.approved` in audit details.

`reject_duplicate` marks the projection as cancelled where the existing schema supports a status change, sends a vendor void notice through `NotificationService.email`, and emits outcome `duplicate_rejected`.

`hold_and_verify` marks the projection disputed where supported, creates a human task through `NotificationService.task`, and emits outcome `held_for_verification` with a 24 hour reminder marker.
