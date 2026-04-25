# @brain/ledger

Layer 2 — Normalized financial truth. Owns the eleven Ledger entities
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

This workspace is the Phase-2 scaffolding of the v0.3 six-layer refactor.
At Phase 2, the workspace ships:

- All 11 migrations with RLS, FKs, indexes, and provenance/confidence/source_ids/evidence_ids columns
- Service-boundary contracts (`IRawEvidenceService`, `ILedgerService`, `IWikiMemoryService`, `IPolicyService`, `IAgentService`, `IAuditService`, `IReconciliationService`, `IPaymentIntentService`, `IApprovalService`)
- Repositories (DB access, tenant-scoped via `withTenantScope`, no business logic)
- A read-only HTTP API exposing every Ledger entity for external consumption
- A Fastify app factory (`buildLedgerApp`)

What it does NOT yet do (lands in subsequent refactor phases):

- Phase 3: rewrites the Plaid extractor to write Ledger rows. Until then the tables are empty under tenant scope.
- Phase 4: implements the §6 pre-execution gate and the PaymentIntent execution flow.
- Phase 5: implements the reconciliation engine.

## Local development

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

## Layer boundary contract

The Ledger never reads from the Wiki. The Ledger never executes a payment.
Mutations originate from Raw extraction, controlled service methods on
`ILedgerService`, or `/wiki/annotate`'s write-through path (which itself
writes a Raw artifact first). See `src/contracts/` for the typed
boundaries.
