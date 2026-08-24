# VM to Azure data migration scope

Status: scope only. This document does not authorize a data copy, Terraform apply, application deployment, traffic cutover, DNS change, or feature-flag change.

## Goal

Move the authoritative production state from VM-hosted Postgres, MinIO, and Redis to Azure Database for PostgreSQL, Azure Blob Storage, and Azure Managed Redis with measured completeness, bounded downtime, and an explicit rollback boundary.

## Core rule

There must be one authoritative write location at every point in the migration. VM and Azure application revisions must never accept concurrent production writes against divergent data stores. DNS movement is the last step after the final copy, integrity checks, dependency validation, and a human go decision.

## Discovery inventory

Before designing commands, capture a read-only inventory from both environments:

- Exact VM and Azure database server identities, versions, extensions, schemas, migration versions, roles, grants, row-level security policies, database sizes, table row estimates, sequence values, and large-object usage.
- MinIO buckets, object counts, logical bytes, versions, retention or legal holds, metadata, content types, and object-key patterns.
- Azure Blob containers, versioning, immutability, legal holds, lifecycle policies, and current object inventory.
- Redis versions, topology, TLS and authentication settings, memory usage, eviction policy, keyspace counts by prefix and type, TTL distribution, BullMQ queue state, active workers, and delayed jobs.
- Every VM `.env.prod` secret type and its Azure Key Vault destination by name. Inventory names and consumers only, never values.

The inventory report must identify the source as the authoritative VM production environment and the target as the intended Azure production resources using subscription, resource group, server, storage account, and cache identifiers.

## Postgres migration scope

Treat the database as one referential and audit-integrity unit. Do not copy a hand-selected subset of tables. The transfer includes all migrations and data owned by the API, auth, canonical, execution, ledger, policy, raw, surface-gateway, wiki, and audit services.

The verification manifest must explicitly cover:

- Tenants and tenant settings.
- Auth users, password credentials, sessions, refresh state, authorization state, OAuth clients, and identity records.
- Members, member identity links, deactivation state, approval permissions, and attribution data.
- Invites, including normalized email, expiry, consumption, revocation, and tenant association.
- API keys, stored digests, scope assignments, expiry, revocation, rate-limit state that is durable, and usage attribution.
- Ledger, canonical, raw metadata, policies, agents, proposals, approvals, execution state, outboxes, schedulers, and idempotency records stored in Postgres.
- Audit events, event hashes, chain order, Merkle roots, anchor rows, publisher and reconciler state, transaction hashes, block references, and pending retry state.
- Sequences, constraints, indexes, triggers, extensions, migration history, grants, ownership, and forced RLS policies.

### Proposed transfer method

Use a rehearsed logical dump and restore unless measured database size or outage limits require Azure Database Migration Service. The selected method must preserve identifiers, timestamps, byte arrays, JSON, constraints, and sequence positions. Restore initially into an isolated target database or server with no production writers.

After restore:

1. Run only migrations not already recorded in the source migration history.
2. Apply `db-roles` after migrations.
3. Compare schema fingerprints and migration versions.
4. Compare per-table counts, primary-key ranges, sequence heads, and deterministic chunk hashes for critical tables.
5. Recompute and verify audit hash chains and anchor linkage without creating new anchors.
6. Sample tenant-scoped reads through every least-privilege role and prove RLS isolation.
7. Validate auth login and token verification without invalidating existing identities unless session rotation is an approved migration decision.

## MinIO to Azure Blob migration scope

Copy raw object bytes and provenance, not just database pointers. Preserve the logical object name expected by `blobPath`, content type, content hash, source tenant prefix, creation time when supported, and required retention metadata.

Because existing database rows may contain MinIO or S3-style `blob_uri` values, the design must choose and document one of these approaches before copying:

- Preserve logical keys and translate backend-specific URIs at adapter resolution time.
- Perform a transactional, audited URI rewrite after every referenced object is verified in Azure Blob.

The copy must be restartable and idempotent. A completed object is accepted only after destination length and SHA-256 match the source. Verification includes counts and bytes per tenant, all object versions that remain legally required, database references with no missing destination object, and no unreferenced destination objects introduced by the migration.

Immutability and legal-hold differences need a manual legal and operational decision. The migration must not weaken an existing retention obligation or accidentally make disposable canary data undeletable.

## Redis and BullMQ migration scope

Redis contains both disposable state and state whose loss can change behavior. Current durable consumers include token revocation, idempotency, rate limiting, SIWX nonces, wiki cache entries, and BullMQ queues. Named queues include raw extraction, webhook ingestion, audit anchoring, agent reconciliation, agent payment, agent anomaly, and agent routing.

Do not perform a blind key copy. Classify every prefix into one of three groups:

| Class                        | Examples                                                                                                       | Treatment                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Durable or security-relevant | Unexpired token revocations and completed idempotency results                                                  | Copy with remaining TTL or reconstruct from a durable source; verify semantics before reopening writes            |
| Recoverable queue state      | Waiting and delayed BullMQ jobs whose durable Postgres record proves they remain due                           | Drain before freeze when possible; otherwise export a reviewed manifest and re-enqueue idempotently after cutover |
| Ephemeral                    | Rate-limit windows, caches, nonces that can safely expire, worker locks, stalled markers, and active-job locks | Do not copy by default; document user impact, allow expiry, and start clean                                       |

The exact classification requires a keyspace report from the live VM. Active BullMQ jobs, locks, and stalled markers must never be copied as if they were valid target ownership. Pause producers, stop schedulers, drain workers to zero active jobs, record waiting and delayed job IDs, and reconcile every retained job against Postgres before re-enqueueing.

For security state such as revocation and idempotency, the runbook must quantify the maximum safe loss window. If faithful TTL-preserving transfer cannot be proven, use a maintenance window long enough for affected entries to expire or force the relevant credential and request-state rotation.

## Rehearsal and final migration sequence

### Rehearsal

1. Take production-consistent snapshots without stopping VM traffic.
2. Restore into isolated Azure targets.
3. Run all integrity checks and Container Apps validation against disposable endpoints.
4. Measure copy duration, final-delta size, application warm-up time, and rollback time.
5. Resolve every mismatch and repeat until the runbook is deterministic.

### Final window

1. Confirm backups, restore tests, named operators, communication path, and rollback deadline.
2. Put the VM application into maintenance or read-only mode and stop all producers, schedulers, workers, webhooks, and agent callbacks.
3. Prove zero active BullMQ jobs and record all retained waiting or delayed work.
4. Take the final Postgres snapshot or delta and complete the idempotent object delta copy.
5. Restore Postgres, apply roles, and load only approved Redis state or re-enqueue manifests.
6. Run full database, audit, object, queue, Key Vault, Redis, and application validation.
7. Obtain an explicit human go decision.
8. Only a later approved cutover procedure may move traffic.

## Rollback model

Before public writes reach Azure, rollback is simple: keep the VM authoritative and discard or rebuild the isolated Azure target.

After the first Azure production write, returning to the old VM database would lose or fork data. The preferred compute rollback is therefore to run the VM application against the same Azure Postgres, Blob, and Redis data plane, provided that path is rehearsed and network access is gated. If that is not feasible, the cutover needs a documented reverse-replication procedure and a strict rollback deadline. DNS or traffic splitting alone is not a safe stateful rollback plan.

The authoritative-store marker, write-fence status, first Azure write time, and rollback decision must be recorded in the run log.

## Automation boundary

### Automate

- Environment identity and source-target inventory.
- Consistent dump, encrypted transfer, restore, and resumable object copy.
- Schema fingerprints, migration comparison, table counts, sequence checks, chunk hashes, object hashes, and reference checks.
- Audit-chain and anchor-state verification.
- Redis keyspace classification reports, TTL capture, BullMQ counts, drain checks, and approved job re-enqueue.
- Service-role, RLS, auth, Blob, Redis, Key Vault, and application canaries.
- Evidence capture, cleanup, and a machine-readable go or no-go summary.

Automation must be fail-closed, resumable, least-privilege, and incapable of logging secret values or plaintext credentials.

### Manual runbook and approval

- Approve the source and target identity evidence.
- Select the transfer method after measuring data size and outage limits.
- Decide session, nonce, revocation, and idempotency handling.
- Review BullMQ jobs that cannot be drained or reconstructed automatically.
- Decide retention and legal-hold mapping for object versions.
- Schedule and announce the write freeze.
- Inspect every integrity mismatch and approve any documented exception.
- Declare the authoritative data plane, approve go or no-go, and activate rollback if needed.
- Approve later traffic, DNS, and feature-flag changes through separate procedures.

## Acceptance gates

- Postgres critical-table counts and deterministic hashes match, with zero unexplained differences.
- All IDs, foreign keys, migration versions, grants, and sequences are valid.
- Audit chains and stored anchor references verify exactly; migration creates no new audit or anchor records merely by copying.
- Every referenced raw object exists in Azure Blob with matching bytes and SHA-256.
- Every retained Redis or BullMQ item has an explicit disposition and no active VM lock is copied.
- Container Apps passes the full deploy-validation matrix against the migrated data.
- Northstar and other production tenants are read-only validation subjects. Evaluator and canary writes use disposable tenants only.
- VM write fencing and Azure authority are externally observable before any traffic change.
- A timed rollback rehearsal has succeeded.

## Checklist

- [x] Required Postgres domains and integrity properties scoped.
- [x] MinIO to Blob object and reference validation scoped.
- [x] Redis state split into durable, recoverable, and ephemeral classes.
- [x] Automation and manual gates separated.
- [x] Terraform, deployment, traffic, DNS, and flag changes explicitly excluded.
- [ ] Capture redacted source and target inventories.
- [ ] Measure database, object, and Redis volumes.
- [ ] Choose and implement the Postgres transfer mechanism.
- [ ] Implement resumable object copy and URI handling.
- [ ] Produce the live Redis prefix classification and queue disposition.
- [ ] Write the operator runbook with exact commands and owners.
- [ ] Complete at least one isolated full rehearsal and timed rollback rehearsal.
- [ ] Review and approve the final migration window before execution.
