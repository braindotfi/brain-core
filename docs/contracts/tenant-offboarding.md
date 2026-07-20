# Tenant Offboarding Contract

This contract covers tenant data portability and erasure for the Brain core API.
It is the developer reference for GDPR Article 20 export and GDPR Article 17
erasure behavior.

## Export Before Erase

A departing tenant should export first, verify the archive, then request
erasure:

1. `POST /v1/tenants/{id}/export`
2. Poll `GET /v1/tenants/{id}/export/{job_id}` until `status=succeeded`
3. Download `GET /v1/tenants/{id}/export/{job_id}/download`
4. Verify the archive with the tenant
5. `DELETE /v1/tenants/{id}`

Export, status, download, and delete are self-only tenant lifecycle actions.
They require `principal_type=user` and `principal.tenantId === id`. Agent and
API partner principals are rejected.

## Tenant Export

`POST /v1/tenants/{id}/export` enqueues an async `tenant_export_jobs` row. The
route is idempotent for in-flight work: when a queued or running job already
exists for the tenant, the API returns that job instead of stacking another
export.

The export worker assembles a single NDJSON archive. Each line is shaped as:

```json
{ "entity_type": "ledger_account", "data": {} }
```

The archive includes:

- Ledger accounts
- Ledger transactions
- Ledger counterparties
- Ledger obligations
- Ledger invoices
- Ledger document rows
- Raw artifact metadata, including blob URIs
- Members
- Sources, excluding encrypted credentials and credential key ids
- Proposals from the unified proposal read model
- Audit events visible to the tenant

The export worker uses tenant-scoped reads for the data assembly. It must not
fabricate rows, summaries, sources, or blob URIs.

## Export Download And Retention

Export archives are sensitive tenant data. The API never returns the internal
blob URI. Download is access-controlled through the same user and own-tenant
authorization rule as export creation.

Archives expire after the configured retention horizon. The default is 7 days
(`BRAIN_TENANT_EXPORT_TTL_MS`). After expiry, download returns 410. The export
worker purges expired archive blobs with single-object deletion and marks the
job with `purged_at`.

## Tenant Erasure

`DELETE /v1/tenants/{id}` is the Article 17 erasure path. It deletes every
tenant-scoped table listed in `TenantDeletionService.TENANT_SCOPED_TABLES`,
including `tenant_export_jobs`. In-flight export jobs do not block deletion.

The deletion path preserves:

- `audit_events`
- `audit_anchors`
- `tenant_blob_purge_jobs`
- `tenant_blob_purge_audit_outbox`
- `audit_integrity_findings`

The audit chain is preserved for financial integrity, forensic review, and
proof verification. Tenant deletion records a `tenant.deleted` audit event.

## Blob Purge

Tenant deletion removes database rows in-band, but raw blob bytes are erased
out-of-band. The deletion service snapshots the tenant raw artifact blob URIs,
enqueues one `tenant_blob_purge_jobs` row, and records the pending blob list in
the deletion response and audit event.

The privileged blob-purge worker later erases the raw bytes under the tenant
prefix. It records lifecycle audit events through the purge audit outbox.

Export archive retention is separate from raw blob erasure. Expired export
archives are purged by object path so the worker does not erase unrelated raw
tenant artifacts.

## Audit Trail

Offboarding emits these audit events:

- `tenant.exported`: emitted after a complete export archive is written and
  before the job is marked succeeded.
- `tenant.deleted`: emitted for the tenant erasure request.
- `tenant_blob.purge_requested`: emitted when raw blob purge is enqueued.
- `tenant_blob.purge_completed`, `tenant_blob.purge_retried`,
  `tenant_blob.purge_exhausted`, and `tenant_blob.purge_blocked_legal_hold`:
  emitted by the blob-purge worker lifecycle.

Audit events never contain export archive contents or token values.
