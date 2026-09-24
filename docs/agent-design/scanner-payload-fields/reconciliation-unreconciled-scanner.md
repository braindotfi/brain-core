# Reconciliation Unreconciled Scanner Payload Fields

The scanner now emits one aggregate reconciliation proposal per tenant alongside the existing transaction proposals. `close_aggregate` is derived from the eligible rows in the scan window: rows with candidates count as matched, rows without candidates count as unmatched, and totals are summed from transaction amounts. If no rows are eligible, no aggregate proposal is emitted.

## Decision Handlers

`confirm_all_matches` reads `candidate_ids`, or falls back to `ranked_candidates[].id`, then calls `LedgerDecisionService.commit_match(candidate_id)` for each candidate. Successful execution closes the proposal with outcome `close_confirmed`.

`escalate_to_accountant` sends the close package through `NotificationService.email`. Until tenant contact storage is first class in this service, the handler reads `accountant_contact` from proposal details and otherwise uses a non-deliverable fallback address.
