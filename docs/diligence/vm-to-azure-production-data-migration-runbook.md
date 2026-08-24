# VM to Azure production data migration runbook

Status: pre-execution plan. This document is concrete enough to build and rehearse the migration tooling, but it is not approved for a production migration window. The decisions marked `PENDING` must be closed first.

This document does not authorize a Terraform apply, application deployment, production write fence, data copy, traffic change, DNS change, or feature-flag change.

Related scope: [`vm-to-azure-data-migration-scope.md`](./vm-to-azure-data-migration-scope.md).

## Outcome

Move the one authoritative production state from the legacy VM to the existing Azure data plane:

- Docker Postgres 16 to Azure Database for PostgreSQL Flexible Server 16.
- MinIO bucket `brain-artifacts` to Azure Blob container `raw-artifacts`.
- Docker Redis 7 to Azure Managed Redis.

The migration preserves every durable identifier, credential digest, audit hash, anchor state transition, object byte, and retained queue obligation. It does not create application records, audit events, anchors, or queue work merely by copying data.

At every instant, only one data plane may accept production writes. This runbook ends with validated Azure data and the legacy VM still fenced. Public traffic movement is a separate, later approval.

## Current decisions

| Area                    | Decision                                                                                                                                                                                        | Reason                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres transfer       | Use a directory-format logical dump and parallel restore as the primary method. Reconsider Azure Database Migration Service only if rehearsal cannot meet the approved outage budget.           | The source and target are both Postgres 16. A logical transfer preserves data while allowing Azure-managed roles and platform-owned settings to remain target-owned. |
| Postgres unit           | Dump and restore the complete `brain` database, not a selected table list.                                                                                                                      | Auth, tenancy, Ledger, audit, anchor, queue recovery, and agent records are referentially connected.                                                                 |
| Blob addressing         | Preserve every object key exactly and do not rewrite `blob_uri`.                                                                                                                                | `raw_artifacts.blob_uri` is a provider-neutral logical key. Both `S3BlobAdapter` and `AzureBlobAdapter` pass the stored value to their provider unchanged.           |
| Blob integrity          | Require source and destination count, logical-byte, and SHA-256 manifests, grouped by tenant and object version.                                                                                | Provider ETags are not a portable content digest, especially for multipart objects.                                                                                  |
| Redis                   | Do not copy the Redis database wholesale. Drain queues, transfer only approved security-relevant entries with remaining TTL, re-enqueue reviewed recoverable jobs, and discard ephemeral state. | BullMQ locks and active ownership cannot move safely. Caches and rate windows are not source-of-truth data.                                                          |
| Rollback before traffic | Remove the Azure candidate and restore VM writers.                                                                                                                                              | No Azure production writes exist yet, so there is no reverse delta.                                                                                                  |
| Rollback after traffic  | Out of scope here. A later cutover must use the same Azure data plane for compute rollback or provide a proven reverse-replication path.                                                        | Returning to the old VM database after an Azure write would fork production state.                                                                                   |

## Decisions that block execution

| Decision                                            | Required owner                       | Required evidence                                                                                                                                    | Status                            |
| --------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Maximum write outage, or RTO, for the final window  | Incident commander and product owner | Measured rehearsal duration plus a signed outage budget                                                                                              | PENDING                           |
| Required RPO                                        | Security owner and product owner     | Approval of RPO 0 for Postgres, raw objects, retained queue work, revocations, and completed idempotency responses                                   | Proposed: RPO 0                   |
| Source-to-target private network route              | Azure owner and VM operator          | Connectivity tests from the selected copy runner to VM services, Azure Postgres, Blob, Redis, and Key Vault without opening public data-plane access | PENDING                           |
| Session handling                                    | Auth owner and security owner        | Decision to preserve Postgres refresh state or revoke sessions at the fence                                                                          | Proposed: preserve Postgres state |
| Redis revocation and idempotency handling           | Security owner                       | Live TTL inventory and a tested TTL-preserving import, or an approved forced credential and request-state rotation                                   | PENDING                           |
| BullMQ retained-job policy                          | Worker owner                         | Per-queue job manifest, durable-record mapping, and a reviewed list of jobs that cannot be reconstructed automatically                               | PENDING                           |
| Object versions, legal holds, and retention mapping | Security owner and legal owner       | Source version and hold inventory mapped to the Azure 2,555-day immutability policy                                                                  | PENDING                           |
| Rollback deadline after a later traffic cutover     | Incident commander                   | Timed compute rollback rehearsal against the Azure data plane                                                                                        | PENDING and outside this runbook  |

If any row remains pending, `final` mode in the proposed workflow must refuse to start.

## Roles and ownership

Names are assigned in the production change record before rehearsal. One person may hold more than one role, except the migration operator and independent verifier must be different people.

| Role                       | Responsibility                                                                    | Named owner                     |
| -------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| Incident commander         | Starts and aborts the window, owns the RTO clock, and records go or no-go         | PENDING                         |
| VM operator                | Performs the direct SSH steps and records VM evidence                             | Sanket, subject to confirmation |
| Azure operator             | Starts gated Azure jobs and confirms resource identity                            | PENDING                         |
| Database operator          | Produces dump, restore, schema, role, and data manifests                          | PENDING                         |
| Object operator            | Runs the resumable copy and object reconciliation                                 | PENDING                         |
| Queue operator             | Pauses producers, drains workers, classifies Redis, and re-enqueues approved jobs | PENDING                         |
| Auth and security approver | Approves session, revocation, idempotency, secret, and retention treatment        | PENDING                         |
| Independent verifier       | Reviews evidence and signs the acceptance matrix                                  | PENDING                         |

## Environment identity gate

Every phase starts by writing a redacted identity record. Friendly container names and workflow labels are not evidence of an environment.

The record must include:

- Source VM subscription, resource group, VM resource ID, private IP hash, Docker compose project, Postgres server version, database system identifier, and database name.
- Target Azure subscription, tenant, resource group `brain-production-rg`, Postgres resource ID and server name, storage account resource ID, Blob container resource ID, Managed Redis resource ID, Key Vault resource ID, and Container Apps Environment resource ID.
- Repository commit used by the migration tooling.
- UTC capture time and operator identity.
- A Boolean assertion that the source is the authoritative VM production data plane and the target is the isolated Azure production data plane.

The workflow compares resource IDs to an approved manifest committed to the change record. A name-only match fails closed.

## Evidence layout

Each attempt gets an immutable run ID such as `migration-20260824T120000Z-<commit8>`. Evidence is stored in an access-controlled change record, not committed to Git.

```text
<run-id>/
  approvals.json
  environment/source.json
  environment/target.json
  postgres/source-catalog.json
  postgres/target-catalog.json
  postgres/table-manifest.ndjson
  postgres/sequence-manifest.json
  postgres/audit-integrity.json
  blob/source-manifest.ndjson
  blob/target-manifest.ndjson
  blob/reconciliation.json
  redis/keyspace-summary.json
  redis/queue-manifest.json
  redis/disposition.json
  validation/results.json
  timings.json
  decision-log.md
```

Evidence may contain record identifiers and object keys. Store it encrypted, restrict it to the migration team, set mode `0600` on the VM, and never upload secrets, Redis values, tokens, raw object bytes, password hashes, API-key digests, or database dumps as workflow logs or normal GitHub artifacts.

## Postgres data unit

The complete database is authoritative. The verification manifest calls out the following domains explicitly so a global count cannot hide a missing critical table.

### Tenancy, identity, auth, and API credentials

- `tenants`, including tenant kind, settings, defaults, and lifecycle fields.
- `users`, password verifier fields, `session_refresh_tokens`, `email_verifications`, and `wallet_identities`.
- `oauth_clients`, `oauth_authorization_codes`, `oauth_consent_grants`, and `oauth_refresh_tokens`.
- `members`, `member_identity_links`, and `member_invites`, including normalized email, role, approval domains, expiry, revocation, consumption, deactivation, and attribution.
- `api_keys`, including server-peppered digests, tenant scope, issuable scopes, expiry, revocation, and usage attribution.
- `production_agent_tokens` and every signing-key reference stored in Postgres. Secret material remains in Key Vault and must match the migrated ciphertext or digest domain.

### Finance, policy, agent, and delivery state

- All `raw_*`, `canonical_*`, `ledger_*`, and `wiki_*` tables.
- `policies`, `policy_decisions`, and `policy_spend_counters`.
- `agents`, `proposals`, `approvals`, `executions`, `execution_outbox`, and all `agent_*` tables.
- Surface tables, webhook endpoints, webhook delivery receipts, webhook dead letters, and domain events.
- Tenant export and blob purge jobs and outboxes.
- Scheduler cooldowns, durable idempotency tables, outbox leases, retry state, and projection quarantine state.

### Audit and anchoring state

- `audit_events`, including `event_hash`, `prev_event_hash`, `hash_schema_version`, classification, actor attribution, correlation, and API-key attribution.
- `audit_anchors`, including Merkle root, event coverage, status, attempt state, transaction hash, block number, contract address, and retry metadata.
- `audit_verifier_checkpoint` and `audit_integrity_findings`.
- Any pending broadcaster, reconciler, or anchor backlog state held in the database.

### Database structure

- `brain_migrations`, every application table, sequence, index, constraint, trigger, function, extension, ownership record, grant, and forced row-level-security policy.
- Required extensions `vector`, `pgcrypto`, and `uuid-ossp` where used.
- Current sequence heads even when a sequence is above the maximum stored identifier.

The automation discovers the live catalog and includes every non-platform table. The lists above are minimum assertions, not an allowlist.

## Postgres transfer procedure

### 1. Inventory

Run read-only catalog collection on source and target:

```text
SELECT version();
SELECT current_database(), current_user;
SELECT system_identifier FROM pg_control_system();
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SELECT key, encode(content_sha, 'hex'), applied_at FROM brain_migrations ORDER BY key;
```

Collect schemas, columns, defaults, constraints, indexes, triggers, RLS flags, policies, roles, grants, table sizes, row estimates, primary keys, foreign keys, and sequence values. The report prints metadata only.

### 2. Produce the source dump

The VM operator uses the source owner role inside the Postgres container so no password appears on the command line:

```bash
ssh azureuser@<production-vm-host>
cd ~/brain-core
umask 077
docker exec brain-prod-postgres pg_dump \
  --username=brain \
  --dbname=brain \
  --format=directory \
  --jobs=4 \
  --no-owner \
  --no-acl \
  --file=/var/tmp/<run-id>-brain.dump
docker cp brain-prod-postgres:/var/tmp/<run-id>-brain.dump ./<run-id>-brain.dump
```

Directory-format parallel dump uses one synchronized snapshot. The resulting directory is encrypted before leaving the VM. The exact encryption recipient, transfer route, and retention duration belong in `approvals.json`. Plaintext dumps are deleted only after restore and independent evidence acceptance, using an approved secure-delete policy for the underlying VM disk.

For rehearsal, the VM remains writable and the dump proves transfer mechanics only. For the final window, run the command only after the write fence is proven.

### 3. Restore into an isolated Azure target

Use an in-VNet Container App Job or other approved private runner. Do not place Azure Postgres on a public network for convenience.

```bash
pg_restore \
  --dbname="$TARGET_DATABASE_URL" \
  --format=directory \
  --jobs=4 \
  --no-owner \
  --no-acl \
  --exit-on-error \
  <decrypted-dump-directory>
```

The restore target must be empty and non-serving. If the existing target contains scaffold or canary data, create a separate rehearsal database. Replacing or clearing an existing database is a destructive action and requires a separately reviewed command with the resolved database resource ID.

After restore:

1. Run `node tools/migrate/dist/cli.js status` and fail on drift.
2. Apply only migrations that are present in the deployment release but absent from the source dump.
3. Run the `brain-production-db-roles` job after migrations.
4. Re-run migration status.
5. Collect the target catalog and data manifests.

### 4. Reconcile Postgres

The proposed `tools/ops/migration/postgres-manifest.ts` generates source and target manifests in read-only transactions:

- Exact count for every table.
- Primary-key minimum and maximum where ordered keys exist.
- Deterministic SHA-256 for bounded primary-key chunks, built from ordered column names, explicit null markers, binary values encoded as hex, and canonical JSON serialization.
- Sequence last value and ownership.
- Schema object fingerprints and migration content hashes.

Never use `row_to_json(... )::text` as the only cross-system proof unless a rehearsal proves identical serialization for every type. The helper must canonicalize values itself and version its manifest format.

Required semantic checks include:

- Every member, invite, API key, and identity refers to an existing tenant.
- Every active tenant has at least one active admin member, unless an explicitly documented legacy exception already exists in the source.
- Every API key digest, scope set, revocation field, and attribution count matches byte for byte.
- Every `raw_artifacts.blob_uri` has a corresponding object manifest entry.
- Every audit chain starts at the same event, has the same ordered hashes, and terminates at the same head for each tenant.
- Every anchor references the same event coverage and retains exactly the same root, status, transaction hash, block reference, contract address, retry count, and error state.
- Restoring data creates zero new audit events and zero new anchors.
- Foreign keys validate and every sequence is at or above the source value.
- Service roles connect over TLS and the RLS canary proves a tenant cannot read another tenant.

Any mismatch is a stop. There is no count tolerance for critical tables.

## MinIO to Azure Blob procedure

### Key and URI decision

The selected design preserves the logical object key. A source key such as:

```text
tnt_.../2026/08/24/<sha256>
```

is copied to the identical key in Azure container `raw-artifacts`. `raw_artifacts.blob_uri` remains unchanged. The inventory must fail if it finds an absolute `s3://`, `http://`, `https://`, `az://`, bucket-qualified, or container-qualified URI. Such a finding requires an audited rewrite design before migration.

Do not copy source bucket name `brain-artifacts` into the key. The target container name is supplied by configuration.

### Source manifest

The source manifest contains one row per retained object version and delete marker:

```json
{
  "key": "logical/key",
  "version_id": "opaque",
  "is_delete_marker": false,
  "bytes": 123,
  "sha256": "hex",
  "content_type": "application/pdf",
  "metadata_sha256": "hex",
  "retention_until": "timestamp-or-null",
  "legal_hold": true
}
```

Generate it by paginating the MinIO version API. Compute SHA-256 by streaming each retained object version, not by trusting ETag. Compute a separate canonical metadata digest. Also produce group totals for each tenant prefix and the whole bucket: object versions, current objects, delete markers, and logical bytes.

The manifest treats keys as sensitive tenant metadata. It must not appear in workflow logs.

### Copy mechanism

Use a pinned `rclone` image or a purpose-built Node migration job that can read the S3-compatible source and write Azure Blob. The implementation must:

- Preserve the key, bytes, content type, and approved user metadata.
- Be idempotent and resumable by `(key, source_version_id, sha256)`.
- Limit concurrency and retry transient errors with a bounded backoff.
- Refuse to overwrite a destination key whose bytes do not match the source manifest.
- Record version and legal-hold disposition without releasing a source hold.
- Write a run correlation tag that is excluded from the content digest.
- Avoid enabling a destination legal hold until the legal and security owners approve the source-to-target mapping. The target container already has a 2,555-day immutability policy, so a mistaken copy may be operationally irreversible.

Because Azure network rules deny general public access, the copy runner must be inside the approved network path. If the legacy VM cannot reach the private destination, the run is blocked until an approved transfer route exists. This runbook does not authorize opening the storage account firewall.

### Destination reconciliation

After the initial copy and again after the final delta:

1. List every Azure version under `raw-artifacts`.
2. Stream each accepted destination version through SHA-256.
3. Compare key, bytes, SHA-256, content type, approved metadata, retention, and hold disposition.
4. Compare count and byte totals globally and by tenant.
5. Join the destination manifest to every Postgres object reference, including `raw_artifacts.blob_uri`, tenant export output URIs, and pending purge outbox URIs.
6. Require zero referenced objects missing from Azure.
7. Require zero unexplained Azure objects. Pre-existing canaries must have an explicit owner and disposition.

Copying does not invoke Raw ingestion, projectors, workers, or audit emitters. Ledger and canonical rows are not duplicated.

## Redis and BullMQ procedure

### Live classification report

Scan keys using `SCAN`, never `KEYS`. Store only prefix, Redis type, count, total bytes estimate, and TTL histogram in the summary. A protected detail file may contain hashed key identities for reconciliation.

Known application prefixes and dispositions are:

| Prefix or structure                            | Semantics                                                                                                | Disposition                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `auth:revoked:*`                               | JWT revocation until original token expiry                                                               | Transfer value and remaining TTL exactly, or revoke affected credentials through an approved fallback. Never shorten TTL. |
| `idemp:<tenantId>:*` with `state=done`         | Completed API response replay, normally 24 hours                                                         | Transfer with remaining TTL after verifying the body hash and tenant.                                                     |
| `idemp:<tenantId>:*` with `state=in_flight`    | Ownership of a request currently executing                                                               | Do not copy. The write fence must let it finish or the operator must resolve it from durable execution and outbox state.  |
| `siwx:nonce:*`                                 | One-use, five-minute sign-in nonce                                                                       | Do not copy. Fence new issuance and wait for expiry.                                                                      |
| `wiki:q:*` or the live wiki cache prefix       | Answer cache                                                                                             | Do not copy. Warm from clean state.                                                                                       |
| `api-key:*`, `mcp:tenant:*`, `wiki:annotate:*` | Sliding-window rate limits                                                                               | Do not copy unless security explicitly requires continuity. Record the reset window as a bounded behavioral effect.       |
| BullMQ queue keys                              | Waiting, delayed, prioritized, active, completed, failed, stalled, events, locks, and scheduler metadata | Never clone Redis keys. Drain and reconstruct only approved work.                                                         |
| Unknown prefix                                 | Unknown behavior                                                                                         | Stop until the owning code and live values establish a disposition.                                                       |

The repository declares these queue names:

- `brain.raw.extract`
- `brain.raw.webhook_ingest`
- `brain.audit.anchor`
- `brain.agent.reconcile`
- `brain.agent.payment`
- `brain.agent.anomaly`
- `brain.agent.route`

A declared queue may be absent or unused in production. The live inventory is authoritative. Any additional BullMQ prefix is an unknown and blocks migration until classified.

### Drain sequence

1. Reject new external writes at the VM boundary.
2. Stop webhook intake and surface callbacks.
3. Stop schedulers and queue producers while leaving consumers running.
4. Poll every live queue until `active=0` and no lock-renewal keys remain.
5. Reconcile in-flight API idempotency entries with Postgres execution and outbox records.
6. Stop `worker`, `agents`, and `surface-gateway` after queues are quiescent.
7. Stop `api` and `auth` or keep only a maintenance responder that cannot reach write credentials.
8. Wait at least the maximum observed SIWX nonce TTL.
9. Export waiting, delayed, prioritized, and failed-job metadata to the protected queue manifest.

The queue manifest records queue, job ID, name, normalized payload hash, tenant ID, state, attempts, delay, timestamp, durable-record reference, and proposed disposition. It must not log plaintext payloads.

### Re-enqueue rules

- Prefer reconstruction from durable Postgres state over Redis payload replay.
- Re-enqueue only waiting or delayed work with a proven durable record that is still due.
- Preserve the stable BullMQ job ID when it is the idempotency boundary.
- Recalculate remaining delay from the original due time in UTC. Jobs already due enter waiting state.
- Do not re-enqueue an anchor whose database row is confirmed, superseded, broadcast, or mined.
- Do not re-enqueue an execution or payment job unless its durable status proves it is safe and authorization remains valid.
- Do not copy active locks, stalled markers, worker identity, scheduler locks, event streams, completed-job retention, or failed-job debugging state as operational ownership.
- Preserve failed-job evidence in the migration record, then require the owning team to choose retry, dead-letter, or leave failed.

After re-enqueue, compare the accepted job manifest to the target queue and require exactly one target job for each approved source obligation.

## Proposed automation

This runbook PR does not implement the following tooling. Implementation should be a separate reviewed PR before rehearsal.

### Production-gated workflow

Add `.github/workflows/ops-vm-to-azure-data-migration.yml` with modes:

- `inventory`: read-only source and target discovery.
- `rehearse`: copy a production-consistent snapshot to an isolated target, never the serving target.
- `verify`: read-only comparison of existing artifacts.
- `final`: disabled until all approval fields are present and the GitHub production environment approves it.

The workflow must use OIDC, pinned action versions, concurrency key `vm-to-azure-production-data`, immutable tool images, a requested commit reachable from `main`, and fail-closed evidence upload. It must never accept database URLs, Redis URLs, or storage keys as dispatch inputs.

GitHub cannot establish the VM write fence by implication. The `final` workflow consumes a short-lived, signed fence attestation produced by the VM helper after it proves the blocked services and zero-active-job condition.

### Helpers

| Proposed helper                            | Mode                     | Responsibility                                                                                                                                             |
| ------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/ops/migration/inventory-vm.sh`    | Read-only                | Record container identity, database catalog, MinIO summary, Redis summary, and service state without printing secret values. Runs only over direct VM SSH. |
| `tools/ops/migration/postgres-manifest.ts` | Read-only                | Produce versioned schema, table, chunk-hash, sequence, audit-chain, and anchor manifests.                                                                  |
| `tools/ops/migration/blob-manifest.ts`     | Read-only                | Stream source or destination object versions and produce SHA-256 and metadata manifests.                                                                   |
| `tools/ops/migration/blob-copy.ts`         | Write to isolated target | Perform resumable key-preserving copy with a local checkpoint.                                                                                             |
| `tools/ops/migration/redis-inventory.ts`   | Read-only                | Use SCAN and BullMQ APIs to summarize prefixes, TTLs, and queue state.                                                                                     |
| `tools/ops/migration/redis-export.ts`      | Read-only after fence    | Export approved revocation, completed idempotency, and recoverable job manifests.                                                                          |
| `tools/ops/migration/redis-import.ts`      | Write to isolated target | Import approved TTL entries and idempotently re-enqueue reviewed jobs.                                                                                     |
| `tools/ops/migration/verify-all.ts`        | Read-only                | Join Postgres, Blob, Redis, and audit evidence into one signed go or no-go report.                                                                         |

Every write helper defaults to dry-run, requires an exact target resource ID and run ID, refuses broad targets, and writes no secret value to stdout or stderr.

## Manual gates and judgment calls

Automation may report facts but may not decide:

- Whether the measured rehearsal meets the business outage budget.
- Whether a database or object mismatch is acceptable. Critical-table or referenced-object mismatches have no automatic exception.
- Whether existing sessions remain valid or are revoked.
- Whether resetting rate windows creates unacceptable abuse exposure.
- Whether an in-flight idempotency marker can be discarded.
- Whether a failed or ambiguous payment, execution, webhook, or anchor job is safe to retry.
- Whether source legal holds and retention obligations map correctly to Azure immutability.
- Whether to start the write fence, declare the Azure copy complete, restore VM writers, or proceed to a later traffic cutover.

All decisions record owner, UTC time, evidence reference, choice, and reason in `decision-log.md`.

## Direct VM SSH task inventory for Sanket

These steps cannot be represented as an Azure-only workflow until a reviewed VM runner replaces SSH. Sanket should receive the exact run ID, source VM resource ID, expected compose project, approved public key, and evidence destination before each session.

| Task | Command class              | Purpose                                                                                | Required inputs                                                                                | Redacted outputs                                                                                                    | Stop conditions                                                                                           | Authorized now                                             |
| ---- | -------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | Read-only inventory        | Prove source identity and measure Postgres, MinIO, Redis, containers, and secret names | Run ID, VM resource ID, host, expected compose project, approved evidence destination          | Resource IDs, versions, image digests, health, counts, bytes, prefixes, TTL histogram, queue counts, variable names | Identity mismatch, unhealthy source, secret value in output, inaccessible evidence destination            | No. This PR is a plan only.                                |
| 2    | Rehearsal copy             | Produce an encrypted live snapshot and manifests without fencing production            | Task 1 evidence, recipient public key, approved transfer path, size and disk budget            | Artifact names, byte counts, SHA-256, timings, retry counts                                                         | Insufficient disk, transfer path not private or approved, unencrypted artifact, source health degradation | No. Requires rehearsal approval.                           |
| 3    | Read-only pre-window proof | Prove no drift and that rollback inputs remain usable                                  | Approved release manifest, backup identifiers, proposed window, exact compose manifest         | Image and file digests, backup restore proof, capacity, health                                                      | Drift, unreadable backup, insufficient capacity, unhealthy dependency                                     | No. Requires approved window.                              |
| 4    | Write fence                | Stop new writes, drain queues, and attest quiescence                                   | Incident commander approval, maintenance procedure, reviewed stop order, RTO clock             | Fence timestamp, stopped services, connection counts, queue counts, hashed job IDs                                  | Any unblocked ingress, active job, live lock, unknown writer, restart loop, RTO breach                    | No. Production availability change, separately authorized. |
| 5    | Final copy                 | Capture RPO 0 Postgres, Blob delta, approved Redis TTL state, and job manifest         | Signed fence attestation, encryption recipient, approved route, accepted Redis disposition     | Artifact checksums, counts, bytes, TTL summary, job disposition summary, timings                                    | Writer after fence, active lock, checksum mismatch, unknown Redis prefix, transfer failure, RTO breach    | No. Production data movement, separately authorized.       |
| 6    | Rollback or hold           | Restore VM writers after no-go, or keep the source safely fenced                       | Incident commander decision, proof Azure accepted no production write, rehearsed restore order | Decision, service health, first restored writer time, authoritative-store marker                                    | Azure write detected, ambiguous authority, unhealthy source, missing backup                               | No. Production availability change, separately authorized. |

Commands shown below are command templates for review. Task 1 is read-only inventory, task 2 is rehearsal copy, task 3 is read-only pre-window proof, task 4 is the write fence, task 5 is the final copy, and task 6 is rollback or hold. None is authorized by merging this document.

### SSH task 1: source identity and read-only inventory

Purpose: prove the correct authoritative VM and measure the source.

```bash
ssh azureuser@<production-vm-host>
cd ~/brain-core
umask 077
git rev-parse HEAD
docker compose -p brain-prod --env-file .env.prod -f docker-compose.prod.yml ps
curl --fail --silent --show-error \
  --header Metadata:true \
  'http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01' \
  | jq '{subscriptionId, resourceGroupName, resourceId, location, vmId}'
docker exec brain-prod-postgres psql --username=brain --dbname=brain --command='SELECT version(), current_database();'
docker exec brain-prod-redis redis-cli INFO server
docker inspect --format '{{.Config.Image}}' brain-prod-minio
```

Concrete outputs:

- Resource identity attestation and Git commit.
- Container names, images, health, restart counts, and volume names.
- Postgres catalog and size manifest.
- MinIO bucket count, bytes, version, hold, and retention summary.
- Redis prefix, TTL, memory, eviction, persistence, and queue-state summary.
- `.env.prod` variable names and consumer mapping only. Do not print values.

### SSH task 2: rehearsal extraction

Purpose: produce a live consistent Postgres dump, source object manifest, and Redis inventory without changing source state.

Concrete actions:

- Create a mode-`0700` run directory outside the repository.
- Produce the directory-format Postgres dump.
- Generate the version-aware MinIO SHA-256 manifest.
- Generate the Redis keyspace and queue summary with SCAN.
- Encrypt the dump and sensitive manifests to the approved migration recipient.
- Transfer them over the approved private or encrypted route.
- Record start, end, bytes, checksums, and transfer retry counts.
- Leave production services running.

### SSH task 3: pre-window proof

Purpose: immediately before the approved window, prove there is no unreviewed VM drift.

Concrete actions:

- Repeat source identity.
- Confirm compose files and deployed image digests match the approved manifest.
- Confirm disk headroom for dump and manifests.
- Confirm a tested VM backup and Postgres restore point exist.
- Confirm the last off-VM MinIO backup is readable.
- Confirm the maintenance response and service-control commands are available.
- Stop if MinIO, Postgres, Redis, or any application container is unhealthy.

### SSH task 4: production write fence and queue drain

Purpose: establish one authoritative, quiescent source snapshot.

This task is destructive to availability and requires the live incident commander approval. The final command list is generated from the deployed compose manifest and must be rehearsed. At minimum it must:

- Enable the maintenance or read-only edge response.
- Block public API, auth mutation, webhooks, Slack, Teams, and agent callbacks.
- Stop scheduler and producer paths.
- Leave workers running until every queue reports zero active jobs.
- Stop `worker`, `agents`, `surface-gateway`, `api`, and `auth` in the reviewed order.
- Prove those containers cannot restart through their compose restart policy.
- Prove Postgres connection activity has no application writer other than the migration session.
- Prove no MinIO object write occurs after the fence timestamp.
- Produce and sign the write-fence attestation.

Do not use a broad `docker compose down`, delete a volume, prune Docker, or stop Postgres, Redis, or MinIO.

### SSH task 5: final extraction and delta

Purpose: capture the RPO 0 source after the fence.

Concrete actions:

- Re-run the Postgres directory dump.
- Re-run the MinIO source manifest and copy only missing or changed version tuples.
- Export approved revocation and completed-idempotency entries with remaining TTL.
- Export the reviewed BullMQ job manifest after confirming zero active jobs and zero live locks.
- Hash and encrypt every artifact.
- Transfer over the approved route and verify receiver checksums before acknowledging completion.
- Keep the VM fenced and all source volumes intact.

### SSH task 6: abort or hold

Purpose: respond to no-go before traffic movement.

On abort, Sanket either keeps the maintenance fence while the incident commander investigates, or restores VM service in the rehearsed reverse order. Before restoring writers, confirm Azure remains non-serving and no Azure production write occurred. Record the decision and exact first VM writer time.

On hold after successful verification, keep the VM fenced, healthy, backed up, and recoverable. Do not delete dumps, containers, or volumes. Public traffic remains unchanged until the separate cutover is approved.

## Rehearsal plan

At least two rehearsals are required.

### Rehearsal A: tooling and integrity

- Use a live, non-fenced source snapshot.
- Restore to an isolated Azure database.
- Copy objects to an isolated rehearsal container without permanent legal holds unless approved.
- Import Redis state into an isolated namespace or database.
- Run all manifests and application read canaries.
- Measure full and incremental copy times.

Expected result: tooling is resumable, all durable data reconciles, and expected live-source drift is bounded by snapshot times rather than misreported as corruption.

### Rehearsal B: timed operational simulation

- Use a production-like disposable stack with the same data volume characteristics.
- Exercise the exact write-fence, queue-drain, final-delta, restore, verify, abort, and VM-resume steps.
- Inject one failed object copy, one stale BullMQ lock, one delayed job, one expired revocation, and one Postgres hash mismatch.
- Prove each fails closed or reaches its reviewed manual gate.

Expected result: measured RTO fits the proposed budget, RPO is zero for required state, and rollback restores writers within its approved time.

Do not rehearse write operations against the Northstar presenter tenant. Use disposable tenant records and isolated targets.

## Final migration phase plan

| Phase                   | Owner                         | Automated work                                                           | Manual gate                                                       | Exit evidence                               |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------- |
| 0. Approve              | Incident commander            | Validate approvals and resource IDs                                      | Name operators, approve RTO and RPO, choose transfer route        | `approvals.json` complete                   |
| 1. Preflight            | VM and Azure operators        | Inventory, backup proof, health, capacity, target isolation              | Accept source and target identity                                 | Matching environment records                |
| 2. Fence and drain      | VM and queue operators        | Queue polling and connection checks                                      | Authorize write fence and resolve ambiguous work                  | Signed fence attestation, zero active jobs  |
| 3. Extract and transfer | Database and object operators | Dump, manifests, delta copy, encryption, checksum                        | Approve any retention handling                                    | Received artifact checksums                 |
| 4. Restore              | Database operator             | Restore, migrations, db roles                                            | Approve target database identity                                  | Restore log and migration status            |
| 5. Reconstruct Redis    | Queue operator                | TTL import and approved job re-enqueue                                   | Decide every ambiguous job                                        | Queue disposition with no unknowns          |
| 6. Verify               | Independent verifier          | Counts, hashes, audit, anchor, Blob, roles, RLS, queue, and app canaries | Accept or reject evidence                                         | Signed `validation/results.json`            |
| 7. Hold                 | Incident commander            | Monitor target and VM fence                                              | Declare no-go, hold, or eligibility for a separate cutover review | Decision log and authoritative-store marker |

There is no traffic phase in this runbook.

## Validation and acceptance criteria

The run is eligible for later cutover review only when all are true:

- Source and target resource IDs match the approved production identity manifest.
- Postgres migration histories have no drift.
- Every source application table exists on target with exact count and deterministic chunk hashes.
- Critical auth, tenant, member, invite, API-key, audit, and anchor fields match byte for byte.
- Constraints validate, sequence heads do not regress, grants match `infra/db-roles.sql`, and forced RLS covers every tenant table.
- Auth password verification and refresh behavior work according to the approved session decision, using disposable accounts.
- Audit chain heads and every stored anchor root and on-chain reference match. The migration produces no new event or anchor.
- Every referenced object exists at the identical logical key with matching byte length and SHA-256.
- Source and target object counts and bytes match by tenant and version disposition, with zero unexplained objects.
- Every Redis prefix has an approved disposition.
- Revocations and completed idempotency entries preserve remaining TTL or the approved security fallback has completed.
- BullMQ reports zero copied locks and exactly one reconstructed job per approved recoverable obligation.
- Container Apps validation passes against the isolated migrated data according to the deploy-validation scope.
- The source VM remains fenced and recoverable, Azure remains non-serving, and no prohibited infrastructure or traffic action occurred.
- The independent verifier signs the evidence with zero unexplained exceptions.

## Abort conditions

Abort immediately on:

- Environment identity mismatch.
- Unapproved source or target network exposure.
- A secret, token, digest, Redis value, raw byte, or dump appearing in logs.
- Any active writer after the fence timestamp.
- Any active BullMQ job or live worker lock at final export.
- Migration drift, restore error, critical-table mismatch, audit-chain mismatch, anchor mismatch, missing referenced blob, object digest mismatch, or unexplained Redis prefix.
- A measured step exceeding the remaining RTO budget.
- Loss of a tested source backup or inability to restore VM service.

## Rollback and recovery

Before any public Azure write, rollback is an abort:

1. Confirm Azure ingress is non-serving and target writers are stopped.
2. Record that Azure accepted no production write.
3. Restore VM services in rehearsed dependency order.
4. Disable the maintenance response.
5. Run VM health, auth, object, queue, audit, and Northstar read checks.
6. Record the first restored VM writer timestamp and the incident reason.
7. Retain Azure evidence and discard or rebuild the isolated target only through a separate destructive-action approval.

After a later cutover, DNS-only rollback is not valid. That later runbook must either point VM compute at Azure Postgres, Blob, and Redis, or prove reverse replication. This plan does not claim that capability exists.

## Done and pending checklist

- [x] Complete Postgres database selected as the transfer unit.
- [x] Auth, identities, members, invites, tenants, API keys, audit, and anchoring explicitly included.
- [x] Provider-neutral Blob key preservation selected as the default URI strategy.
- [x] Count, byte, SHA-256, version, retention, hold, and database-reference reconciliation specified.
- [x] Redis state classified into security-relevant, recoverable queue, and ephemeral state.
- [x] BullMQ drain, stale-lock rejection, durable reconstruction, and exactly-once manifest checks specified.
- [x] Automation tasks separated from manual gates and judgment.
- [x] Direct VM SSH phases and concrete Sanket tasks identified.
- [x] Evidence artifacts, rehearsals, abort rules, rollback, acceptance criteria, and ownership fields specified.
- [x] Terraform, deploy, cutover, DNS, traffic, and feature-flag changes excluded.
- [ ] Assign every owner.
- [ ] Approve RTO, RPO, session treatment, retention mapping, and rollback deadline.
- [ ] Prove the private source-to-target transfer path.
- [ ] Capture the live source and target inventories.
- [ ] Implement and review the gated workflow and helpers.
- [ ] Complete Rehearsal A with zero unexplained durable-state differences.
- [ ] Complete Rehearsal B within the proposed RTO and rollback budgets.
- [ ] Review the exact production commands generated from the deployed compose manifest.
- [ ] Approve a production migration window in a separate change record.

Until every pending item is complete, this remains a plan and must not be treated as an executable production migration authorization.
