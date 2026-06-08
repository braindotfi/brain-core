# Runbook: audit-evidence outbox recovery

Audience: on-call operator. Scope: the `tenant_blob_purge_audit_outbox` table,
which carries the audit-evidence intents for tenant-deletion and blob-purge
lifecycle events. A row that exhausts its delivery attempts is dead-lettered to
`exhausted` and is **mandatory audit evidence that has not been recorded**. This
runbook covers inspecting and replaying those rows.

## When this fires

You are paged by one of:

- `brain.audit.outbox.exhausted.count > 0` (any exhausted row is a red signal),
- `brain.audit.outbox.oldest_pending_age_seconds` beyond the delivery SLO (a
  growing backlog),
- the `[audit-outbox] exhausted mandatory audit-evidence rows present` critical
  log line.

These are emitted every blob-purge worker cycle by `reportAuditOutboxHealth`.

## 1. Inspect (always do this first)

The CLI reads only non-sensitive metadata (id, tenant, event key, action,
attempts, age). It never prints the payload.

```bash
# all exhausted rows
pnpm -C services/api run audit-outbox list

# narrow by tenant or age
pnpm -C services/api run audit-outbox list --tenant tnt_123 --limit 100
pnpm -C services/api run audit-outbox list --status pending --older-than 3600
```

Connects via `DATABASE_PRIVILEGED_URL` (falls back to `DATABASE_URL`). It must be
the `brain_privileged` (BYPASSRLS) role, because exhausted rows belong to
already-deleted tenants with no live request scope.

## 2. Diagnose the root cause

An audit-evidence row exhausts only after the full backoff schedule
(`MAX_OUTBOX_PUBLISH_ATTEMPTS = 12`). The delivery target is the audit emitter
writing to `audit_events`. Common causes:

- the audit DB was unavailable for an extended window (now recovered),
- a per-tenant advisory-lock contention storm (now cleared),
- a genuine bug in the event payload (rare; inspect `last_error` in the table).

Confirm the underlying audit path is healthy before replaying, or the replay
will just exhaust again. A quick check: emit any normal event and confirm it
lands, or watch `brain.audit.consistency.*` gauges are clean.

## 3. Dry-run the replay

**Always dry-run first.** This lists exactly which rows would be requeued, with
no mutation and no audit event:

```bash
pnpm -C services/api run audit-outbox replay --operator you@brain.fi --dry-run
# scope it down if needed
pnpm -C services/api run audit-outbox replay --operator you@brain.fi \
  --tenant tnt_123 --older-than 86400 --dry-run
```

## 4. Replay

Drop `--dry-run` to requeue. Each requeued row goes back to `pending` (attempts
cleared, due now) and is redelivered on the next worker cycle. The replay itself
is audited: one `audit.outbox.replayed` evidence intent per affected tenant
(operator identity + replayed event keys) is enqueued in the SAME transaction as
the requeue, so the recovery action and its audit record commit atomically and
the evidence survives an audit-path blip. The worker then delivers it
idempotently on its next cycle, on that tenant's chain.

```bash
pnpm -C services/api run audit-outbox replay --operator you@brain.fi --tenant tnt_123
```

Filters (all AND-ed): `--tenant`, `--event-key`, `--id`, `--older-than <seconds>`,
`--limit <n>` (default 100).

## 5. Verify

```bash
# the requeued rows should now be pending, then drain to published within a cycle
pnpm -C services/api run audit-outbox list --status pending
pnpm -C services/api run audit-outbox list --status exhausted   # should shrink
```

Watch `brain.audit.outbox.exhausted.count` return to 0 and
`brain.audit.outbox.pending.count` drain. Confirm an `audit.outbox.replayed`
event exists for each affected tenant.

## Safety notes

- Replay is idempotent end-to-end: delivery is keyed on the row's unique
  `event_key`, so a redelivery that already wrote the event returns the existing
  one rather than duplicating it.
- The CLI never moves money and never touches the §6 gate. It only requeues
  audit-evidence delivery.
- If rows keep re-exhausting after replay, stop and escalate: the audit write
  path itself is unhealthy, and replaying will not help until it recovers.
