# RFC 0003. Blob purge carveout for GDPR Article 17 (right to erasure)

- **Status:** Proposed. Awaiting human signoff before phase B implementation.
- **Date:** 2026-05-30
- **Authors:** ai-assisted
- **Affects:** `Brain_MVP_Architecture.md` Layer 1, `Brain_Engineering_Standards.md`
  §1 Non-Negotiable Principles, `shared/src/blob/types.ts` (`BlobAdapter`),
  `services/api/src/tenant-deletion/service.ts`, a new `tenant_blob_purge_jobs`
  migration in `services/api/migrations/`, and a new worker under
  `services/api/src/workers/`.

> This RFC is the architectural answer to the **tension between Layer-1
> immutability and Article 17 erasure** that surfaced in the
> `tenant-deletion` blob-honesty fix (commit `eda34d1`). Today the deletion
> endpoint surfaces the `raw_artifacts.blob_uri` list it CAN'T erase. This
> RFC proposes how to actually erase them while preserving everything that
> makes Brain auditable.
>
> Phase A (this document) lands the carveout text + RFC. Phase B (the
> implementation) is gated on signoff. No code changes ship as part of
> phase A.

## 1. Problem. Two correct rules, one collision

Brain has two rules that, today, contradict each other.

### Rule A. Layer-1 immutability (Brain_MVP_Architecture.md, Layer 1)

> "Mutation of the original ingested payload is forbidden, only tombstoning
> and parser-output re-derivation are allowed."

This is what makes the Ledger and the Wiki re-derivable from Raw. It is
the technical foundation of "every claim Brain makes is traceable to source
evidence." Without it, the audit chain is reduced to "trust us." With it,
anyone can re-run the extraction pipeline and reach the same Ledger rows.

The `BlobAdapter` interface (`shared/src/blob/types.ts`) reflects this:
there is `tombstone(path, by)` (metadata flag, bytes preserved) but no
`delete()` or `purge()`. Tombstones survive a row delete; bytes do not
disappear.

### Rule B. GDPR Article 17 (right to erasure)

A data subject has the right to have their personal data erased without
undue delay. The carveout in Article 17(3)(b) allows retention for
"the establishment, exercise, or defence of legal claims". Which is
how Brain preserves `audit_events` + `audit_anchors` through tenant
deletion today. But that carveout **does not extend to the raw artifacts**
(bank statements, invoice PDFs, scanned receipts) the user uploaded. Those
contain the user's PII and are exactly what Article 17 is written to
protect.

### The collision

`DELETE /v1/tenants/{id}` today:

1. DELETEs rows from `raw_artifacts` (and 30+ other tenant-scoped tables).
2. Returns `blobUrisPendingPurge`. The URI list the operator must purge
   out-of-band because the BlobAdapter has no in-band purge path.

A truthful read of this is: **the deletion endpoint is misleading by
contract**. The DB row goes away (giving the user a "deletion succeeded"
response), but the bank statement PDF in Azure Blob Storage remains
forever. If the user files an Article 17 demand and Brain claims it was
honored, that claim is false in any deploy without out-of-band cleanup.

The peer reviewers have flagged this in three consecutive reviews
(`recommendations-0464363` rec #3, `review-and-recommendations-aab8a30`
risk #3, `brain_core_recommendations_latest` P0.3). The first two were
satisfied by the honesty fix. The third names the architectural follow-up
as a P0.

## 2. Proposal. A bounded carveout, not a blanket repeal

The Layer-1 immutability rule **is correct** for everything inside a
tenant's operational lifetime. It must not be repealed. What needs to
change is one specific, durable, audited path: **tenant deletion under
Article 17**.

### 2.1 The amended Layer-1 statement

Replace the Brain_MVP_Architecture.md Layer 1 "What Raw must not do"
paragraph with:

> "Raw must not store financial conclusions as authoritative facts. A
> receipt is a Raw artifact; the obligation it implies is a Ledger row
> derived from extraction. The two never share a column. **Mutation of an
> ingested payload during a tenant's operational lifetime is forbidden;
> only tombstoning and parser-output re-derivation are allowed.**
> Exception: when a tenant exercises GDPR Article 17 right-to-erasure
> via `DELETE /v1/tenants/{id}`, the privileged tenant-deletion path
> additionally enqueues durable blob-purge jobs that hard-delete the
> ingested bytes. The hard delete is itself recorded in the audit chain
> via `tenant_blob.purge_requested` / `_completed` / `_failed` events,
> so the act of erasure is verifiable on-chain even after the evidence
> is gone. No other code path may hard-delete Raw bytes; the
> `BlobAdapter.purge()` method is restricted by call-site lint to the
> tenant-deletion worker."

### 2.2 What stays protected

Even after Article 17 erasure:

- `audit_events` for the deleted tenant remain (financial-integrity
  legitimate-interest carveout under Article 17(3)(b)).
- `audit_anchors` (Merkle roots on Base) remain. **Erasure of the user's
  blob bytes does not invalidate the chain**. The audit events reference
  blob URIs (and content hashes via parser-output), not the bytes
  themselves. Re-derivation is no longer possible after erasure; that is
  the price of erasure.
- The new `tenant_blob.purge_*` audit events are written BEFORE the bytes
  are deleted (purge_requested) and AFTER each blob (purge_completed),
  and they are themselves anchored. The act of erasure is permanently
  attestable.

### 2.3 Implementation shape (phase B, NOT this RFC)

**Migration.**
```sql
CREATE TABLE tenant_blob_purge_jobs (
  id                  TEXT PRIMARY KEY,             -- tbpj_<ulid>
  tenant_id           TEXT NOT NULL,                -- subject of erasure
  blob_uri            TEXT NOT NULL,                -- target (azure path)
  requested_by        TEXT NOT NULL,                -- user_id from the DELETE call
  requested_at        TIMESTAMPTZ DEFAULT now(),
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending|in_progress|completed|failed
  attempts            INT NOT NULL DEFAULT 0,
  last_attempted_at   TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  last_error          TEXT,
  audit_event_id      TEXT                          -- the tenant_blob.purge_completed event
);
CREATE INDEX ON tenant_blob_purge_jobs (status, requested_at);
```

**Adapter.** Add to `BlobAdapter`:
```ts
/** Hard-delete bytes. RESTRICTED to the tenant-deletion blob-purge worker.
 *  Bypasses the Layer-1 immutability rule under the Article-17 carveout
 *  (see RFC 0003). Other call sites are forbidden by lint. */
purge(path: string, by: string): Promise<void>;
```

Implement on memory + s3 + azure. A new CI guard
`check-blob-purge-callsites.mjs` greps for `\.purge\(` and fails when
the call site isn't `services/api/src/workers/tenant-blob-purge-worker.ts`.

**Worker.** `tenant-blob-purge-worker.ts`:
- Polls `tenant_blob_purge_jobs` where `status='pending'`.
- For each row: emit `tenant_blob.purge_requested`, call
  `BlobAdapter.purge(uri, by)`, transition to `completed` and emit
  `tenant_blob.purge_completed` (or `_failed` with `attempts++` on error
  and exponential backoff up to N retries; final exhaustion emits
  `tenant_blob.purge_exhausted`).
- Same back-pressure pattern as `webhook-dispatch-worker.ts` so the
  failure surface is consistent.

**Service change.** `TenantDeletionService.deleteTenant()` adds, inside
the existing transaction, an `INSERT INTO tenant_blob_purge_jobs` per
URI. The result's `blobUrisPendingPurge` field stays for backwards
compatibility but is now informational; the purge is **enqueued**, not
deferred-without-handle.

### 2.4 Audit-chain impact

A signed-off RFC must answer: does this erode the audit story?

| Claim                                          | Before erasure | After erasure |
| ---------------------------------------------- | -------------- | ------------- |
| The audit chain is append-only                 | yes            | yes           |
| Merkle roots are anchored on Base              | yes            | yes           |
| `/v1/audit/verify` reproduces the proof        | yes            | yes           |
| Every ledger row references source evidence    | yes            | yes (evidence hash + URI; bytes gone) |
| Re-derivation from Raw is possible             | yes            | **no** for the erased tenant |
| The fact of erasure is itself on-chain         | n/a            | **yes** (via `tenant_blob.purge_*` events) |

The audit chain remains complete and verifiable. What changes is that
**re-extraction is no longer possible** for the erased tenant's data,
which is the correct trade for honoring Article 17.

## 3. Scope of the carveout (strict)

The carveout is intentionally narrow. It applies ONLY when ALL of:

1. The caller is the `tenant-blob-purge-worker.ts` worker.
2. The originating action is `DELETE /v1/tenants/{id}` (a tenant exercising
   self-deletion; principal_type=user, principal.tenantId === target).
3. A row in `tenant_blob_purge_jobs` exists for the URI with
   `status='pending'`.

Any other call to `BlobAdapter.purge()` is a code bug, caught by the CI
guard. There is NO admin-purge path. There is NO operator-purge path. The
only way to hard-delete Raw bytes is for the tenant itself to invoke
their Article-17 right.

## 4. Open questions for signoff

1. **Anchor frequency for the purge events.** Should `tenant_blob.purge_*`
   events trigger an immediate anchor, or wait for the normal anchor
   cadence? Immediate gives the user a verifiable proof of erasure
   faster; the normal cadence is operationally simpler. **Recommend:
   normal cadence**, since the audit event itself is durable and the
   anchor is the cryptographic attestation, not the visibility surface.
2. **Retry policy.** Same as `webhook-dispatch-worker` (exponential
   backoff, MAX attempts, DLQ event). **Recommend yes**, for consistency.
3. **`tenant_blob_purge_jobs` row retention.** Keep forever (so the
   audit story of "we erased this on date X" persists), or hard-delete
   the job row when the audit event is anchored (since the audit event
   carries the same info)? **Recommend keep forever**. Small table,
   diligence-readable.
4. **Blob backend lifecycle policy as a backstop.** Should we also
   configure Azure Blob lifecycle policy to hard-delete tombstoned
   blobs after N days, as a backstop for tombstone-only paths (today's
   `/v1/raw/{raw_id}` DELETE)? **Recommend yes**, separate workstream;
   tracked outside this RFC.

## 5. Acceptance criteria for phase B (post-signoff)

- [ ] Migration adds `tenant_blob_purge_jobs` table; rolled back cleanly.
- [ ] `BlobAdapter.purge()` implemented on memory + s3 + azure.
- [ ] `check-blob-purge-callsites.mjs` CI guard wired into `pnpm run lint`.
- [ ] `tenant-blob-purge-worker.ts` polls and processes jobs with the
      retry policy and audit-event emission described above.
- [ ] `TenantDeletionService.deleteTenant()` enqueues a purge job per URI
      inside the existing transaction.
- [ ] Unit tests: worker happy-path, retry, exhaust, blob-not-found,
      adapter-error.
- [ ] Integration test: `DELETE /v1/tenants/{id}` returns 200, deletion
      result carries `blobPurgeJobsEnqueued: N`, jobs exist in DB,
      worker picks them up and emits the audit events.
- [ ] CLAUDE.md "Known in-Progress Work" section updated (blob purge
      becomes a shipped item, with a pointer to this RFC).
- [ ] `docs/enterprise-readiness.md` "Blob purge (deferred)" section
      becomes "shipped" with the worker named.

## 6. Out of scope

- Hard-delete of Raw bytes outside Article-17 erasure (still forbidden).
- An admin / operator purge endpoint (still forbidden).
- Blob lifecycle policy for tombstoned-but-not-deleted blobs (separate
  workstream).
- Erasure of Ledger / Wiki / Audit data (governed by existing
  tenant-deletion path, unchanged).

## 7. Decision request

Approve the carveout text in §2.1 and the implementation shape in §2.3?
If yes, phase B is mechanical work (~one batch). If the answer is "no,
hold the line on §3 immutability and accept the Article-17 gap as a
known limitation," tenant deletion stays a partial-erasure endpoint and
the marketing/legal posture needs to match. Diligence material would
need to say "tenant deletion removes the data Brain controls; user
uploads in Azure Blob persist subject to operator manual purge."

The recommendation is to approve. The cost of the carveout is one new
table, one new worker, one new BlobAdapter method, and a lint guard. The
benefit is closing a real GDPR claim gap that has been flagged in three
consecutive peer reviews and that diligence buyers will eventually ask
about.
