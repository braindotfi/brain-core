# Audit Log Service

## Purpose

The audit log service projects decision events into a queryable append-only log
for the Approvals log UI and CSV export.

## Events

The consumer handles `decision.executed`, `decision.proposed`,
`decision.auto_executed`, and `decision.escalated`. Each event is idempotent by
tenant and source event id.

## Entry Shape

Each entry stores tenant id, occurrence time, actor type, actor id, actor display
name, proposal id, agent, decision, outcome, policy context, and a
`payload_snapshot_id`. The payload snapshot freezes the event inputs, outputs,
and state envelopes so later proposal edits do not change historical records.

## Retention

Rows stay readable through the same API after archive. The archive job marks
rows older than the cutoff with `archived_at` and can store a CSV copy in object
storage. Seven-year retention is implemented as a data-retention policy on this
append-only table and archive path.

## API

The service exposes `GET /v1/audit-log`, `GET /v1/audit-log/{id}`, and
`POST /v1/audit-log/export`. Filters include time range, actor type, agent,
decision, limit, and cursor. Export returns a signed CSV URL.
