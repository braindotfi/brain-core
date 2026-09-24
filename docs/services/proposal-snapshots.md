# Proposal Snapshot Service

## Purpose

Proposal snapshots freeze proposal payload JSON for previews and historical
decision records. The rules preview endpoint can evaluate sample payloads, and
the audit log stores stable references to payload state at decision time.

## Data Model

Snapshots are stored in `proposal_payload_snapshots` with UUID id, tenant id,
payload JSON, payload hash, creator, and created timestamp.

## Immutability

The API exposes only create and read operations. There is no update or delete
route. The database table has tenant isolation and no mutable business fields.

## API

`POST /v1/proposal-snapshots` accepts `{ "payload": { ... } }` and returns the
snapshot id plus hash metadata. `GET /v1/proposal-snapshots/{id}` returns the
frozen payload.
