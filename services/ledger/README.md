# @brain/ledger

Layer 2, Normalized financial truth. Owns the eleven Ledger entities
defined in `Brain_MVP_Architecture.md` §3 Layer 2:

1. Account
2. Balance
3. Transaction
4. Counterparty
5. Obligation
6. Document
7. Category
8. Transfer
9. Invoice
10. PaymentIntent
11. ReconciliationMatch

## Status

This workspace is the production Ledger package for the six-layer refactor. It
ships:

- All 11 migrations with RLS, FKs, indexes, and provenance/confidence/source_ids/evidence_ids columns
- Service-boundary contracts (`IRawEvidenceService`, `ILedgerService`, `IWikiMemoryService`, `IPolicyService`, `IAgentService`, `IAuditService`, `IReconciliationService`, `IPaymentIntentService`, `IApprovalService`)
- Repositories (DB access, tenant-scoped via `withTenantScope`, no business logic)
- A read-only HTTP API exposing every Ledger entity for external consumption
- A Fastify app factory (`buildLedgerApp`)
- Canonical projection workers for GL accounts, AP/AR, and connector-sourced
  accounts and transactions
- PaymentIntent and reconciliation read/write paths used by execution workers

Plaid, Stripe, and Finch parser rows do not write Ledger rows directly. The
registered extractors validate parser shape and return no direct rows. Connector
data flows through `raw_parsed` to `canonical_account`,
`canonical_transaction`, `canonical_counterparty`, and `canonical_obligation`;
Ledger projection workers materialize the tenant-scoped Ledger rows.

## Local Development

```bash
pnpm -C services/ledger run typecheck
pnpm -C services/ledger run test
pnpm -C services/ledger run test:integration   # requires DATABASE_URL
```

Run migrations against a local Postgres:

```bash
DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
  node tools/migrate/dist/cli.js up
```

## Layer Boundary Contract

The Ledger never reads from the Wiki. The Ledger never executes a payment.
Mutations originate from Raw extraction, controlled service methods on
`ILedgerService`, or `/wiki/annotate`'s write-through path (which itself
writes a Raw artifact first). See `src/contracts/` for the typed
boundaries.
