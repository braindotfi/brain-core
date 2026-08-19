# Northstar Labs VC Demo Test Script

This walkthrough matches the current six-tab Ledger UI. Run it only after the
Northstar seeder has completed successfully against an isolated tenant. The
fixture dates are relative to its seed timestamp, so describe dates as current
or overdue instead of naming a fixed calendar month.

Do not rehearse the Assistant evaluator or provisioning dry run against the
permanent presenter tenant. Use a disposable Northstar tenant for automated or
repeated questions. The permanent tenant should receive only real presenter
activity.

1. Open Overview. Verify `Cash in accounts` is $1,682,750.00. Its caption must
   say the corporate card is excluded. Verify net cash flow is $108,333.33 per
   month, Liabilities is $221,300.00, AR over 30 days is $280,000.00, and the
   largest cash holding is the $1,200,000.00 Northstar Reserve account.
2. Open Ledger, then Accounts. Verify Northstar Operating is $482,750.00,
   Northstar Reserve is $1,200,000.00, and Northstar Corporate Card is
   $28,640.00. The USD Cash Total must remain $1,682,750.00 and must say cards
   and borrowing are shown separately.
3. Open Cash Flow. Verify Income, Expenses, and Liabilities appear above the
   combined transaction list. The 12 seeded months contain 48 posted
   transactions and reconcile to $1,300,000.00 annual net cash flow. The latest
   seeded month is positive $162,000.00.
4. Open Payables. Verify all seven named obligations total $221,300.00.
5. Open Receivables. Verify five named invoices total $530,500.00. Helio
   Manufacturing and Apex Health account for $280,000.00 overdue.
6. Open Counterparties. Verify 12 named records: six vendors, five customers,
   and the Internal Revenue Service tax authority.
7. Open Inbox. Verify exactly two pending Collections recommendations reference
   Helio Manufacturing and Apex Health with invoice and counterparty evidence.
8. Open Rules, then Default. Verify the page says `Northstar curated policy`,
   version 2 is active, and the cards use presentation labels such as `Approved
Vendor Payments`. No raw rule id or `vendors.policy_allowlisted` value should
   appear. Confirm approved-vendor ACH automation is capped at $10,000.00 and
   unmatched payments wait for approval.
9. Open Audit. Verify normal Ledger, policy activation, and proposal-created
   events exist. Before first presentation, verify there are no `wiki.question`
   events and no evaluator-generated history on the permanent tenant.
10. During a disposable-tenant rehearsal, ask `Why is Collections requesting
review?`, `Show recent cash flow`, and `What are the pending
recommendations?`. Verify the answers name Helio Manufacturing and Apex
    Health where relevant and contain neither `cp_` counterparty ids nor the
    literal `no_match`. Do not repeat this rehearsal on the permanent tenant.
11. Present on-chain anchoring as live only when staging health reports
    `onchain_rpc` healthy. If it reports degraded, describe anchoring as
    temporarily unavailable and do not perform a live anchor demonstration.

Record the tenant id, seed timestamp, seed output, observed totals, current
health result, and any cross-surface mismatch in the final validation record.
