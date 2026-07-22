# Blob Backup and Restore Runbook

## Current state: no backup, no snapshot, no replication

Production raw blob storage is a single MinIO container
(`brain-prod-minio`) on one VM, backed by one named Docker volume
(`minio-data`). There is currently no backup, no periodic snapshot, and no
replication of that volume anywhere else.

This matters because of what Postgres does and does not hold. Every
`raw_artifacts` row stores a `blob_uri` pointer and a `sha256` content hash;
it does not store the bytes. The bytes live only in MinIO. If the VM's disk
is lost, corrupted, or the `minio-data` volume is deleted, every raw artifact
(bank statement PDFs, invoice uploads, connector payloads) is permanently
unrecoverable. Postgres would still show the rows and the hashes, but every
`blob_uri` would point at nothing. This is a real, currently-unmitigated data
loss exposure; see `docs/risk-register.json` (R-17).

**This is not yet a scheduled operation.** Nothing below runs automatically
today. Until an operator wires the procedure into a scheduler (cron, a
systemd timer, or a CI job against the VM), production blob data has zero
redundancy.

## Prerequisites

- SSH access to the target VM as `azureuser`.
- The MinIO root credentials for that environment (`MINIO_ROOT_USER` /
  `MINIO_ROOT_PASSWORD` from `.env.staging` or `.env.prod`).
- The `mc` (MinIO Client) binary, or use the `minio/mc` image already pinned
  in `docker-compose.prod.yml` so the backup tool matches the pinned server
  version.
- Enough free disk (or a second bucket/target) to hold a full copy of
  `minio-data`. Check current usage first with `docker exec brain-prod-minio
du -sh /data`.

## Procedure: off-VM backup with `mc mirror`

`mc mirror` walks a bucket and copies every object to a destination, so it
works against the live, running container without stopping it.

1. SSH to the target VM.

   ```bash
   ssh azureuser@<vm-host>
   cd ~/brain-core
   ```

2. Point `mc` at the running MinIO container and at a backup destination.
   The destination should be off-VM: another MinIO/S3-compatible endpoint,
   an Azure Blob container, or (at minimum, as an interim measure) an
   attached disk that is not the VM's own boot/data disk.

   ```bash
   docker run --rm --network container:brain-prod-minio \
     -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@localhost:9000" \
     minio/mc:RELEASE.2024-10-08T09-37-26Z \
     mirror --overwrite local/brain-artifacts /backup-destination/brain-artifacts
   ```

   Replace `/backup-destination/...` with a real off-VM target: an `mc alias`
   pointed at a second MinIO/S3 endpoint (`mc alias set backup https://...`)
   is the more realistic form of this command than a local path, since a
   local path on the same VM does not protect against disk loss.

3. For a full point-in-time copy instead of an incremental mirror, stop
   writes first (scale the `worker` and `api` services down, or accept a
   short window of eventual consistency), then run the same `mc mirror`
   command. Because ingestion is append-only and blobs are immutable once
   written, an incremental `mc mirror` run while the stack is live is safe:
   it can only ever be missing the most recent objects, never corrupt an
   existing one.

## Verification

After a mirror run, confirm the destination actually holds what the source
holds before trusting the backup:

```bash
docker run --rm --network container:brain-prod-minio \
  -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@localhost:9000" \
  minio/mc:RELEASE.2024-10-08T09-37-26Z \
  du local/brain-artifacts

# Compare against the destination's own object count/size (`mc du backup/brain-artifacts`
# once the backup alias is configured).
```

A backup that has never been restored is not a proven backup. Periodically
pick a known `blob_uri` from `raw_artifacts`, fetch it from the backup
destination, and confirm its SHA-256 matches the `sha256` column on the
corresponding `raw_artifacts` row.

## Restore

1. Confirm the failure: `docker compose -p <project> ps` shows `minio`
   unhealthy, or object reads through the API are failing.
2. Provision a fresh `minio-data` volume (or a fresh disk) on the recovery
   VM.
3. Start a bare MinIO container against the empty volume, create the
   `brain-artifacts` bucket (matching `BLOB_CONTAINER` /
   `docker-compose.prod.yml`'s `minio-setup` step), then mirror the backup
   destination back into it:

   ```bash
   mc mirror --overwrite backup/brain-artifacts local/brain-artifacts
   ```

4. Bring the rest of the stack up pointed at the restored MinIO
   (`docker compose ... up -d --no-deps api worker`) and spot-check a known
   `blob_uri` resolves and its bytes hash-match the `raw_artifacts.sha256`
   column, the same check as verification above.
5. Postgres and MinIO are independent stores; a restore only recovers
   objects that existed in the backup at mirror time. Any artifact ingested
   after the last successful mirror and before the failure is still lost.
   Shortening that window is exactly what scheduling this procedure (see
   above) is for.

## Follow-up

- This procedure is manual today. The real fix is infrastructure: either
  point-in-time replicated object storage, or a scheduled off-VM snapshot
  job running this same `mc mirror` step unattended with alerting on
  failure. Neither is implemented; see R-17 in `docs/risk-register.json`.
- `docker-compose.prod.yml` now pins `minio` and `minio-mc` to specific
  release tags instead of `:latest`, so an unreviewed upstream MinIO release
  cannot land on the VM on the next `docker compose pull`. An operator
  should confirm the pinned tags are still current, supported releases
  before the next production deploy, and bump them deliberately going
  forward rather than reverting to `:latest`.
