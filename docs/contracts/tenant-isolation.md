# Tenant Isolation Contract

This contract is the developer-facing guarantee for tenant-scoped data access in
Brain Core.

## Guarantee

Every tenant-scoped read is enforced by PostgreSQL row-level security through
`withTenantScope`. A request principal may read only rows for
`principal.tenantId`. An id-in-path route must not let one tenant read another
tenant's resource by guessing or copying an id.

Cross-tenant id reads must return a not-found or denied response. They must
never return another tenant's data, even when the referenced id is valid for a
different tenant.

## Covered Surfaces

The isolation contract applies to:

- `GET /v1/proposals/{id}`
- `POST /v1/evidence/resolve`
- Ledger id reads for accounts, transactions, counterparties, obligations, and
  invoices
- Tenant export creation, status, and download routes
- Raw extraction status routes
- Raw source sync job status routes

## Test Contract

`services/api/src/security/tenant-isolation.integration.test.ts` is the
route-level contract test. It seeds two real tenants in PostgreSQL, creates
tenant A resources, authenticates as tenant B, and verifies that id-in-path reads
return not-found or denied responses without leaking tenant A data.

This suite must use real PostgreSQL and tenant-scoped request principals. Mocks
are not sufficient for this contract because the guarantee depends on RLS, path
id handling, and route-level authorization working together.

## Development Rule

New tenant-scoped id-in-path read routes must either be added to the isolation
suite or have an explicit reason they are not tenant-owned. Request paths must
not use a BYPASSRLS role. Cross-tenant enumeration workers may use dedicated
read roles only for worker-owned scans, never for request-path reads.
