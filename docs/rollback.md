# Rollback Runbook

Brain currently deploys each environment to a single Docker VM through
`.github/workflows/main.yml`.

- `deploy_staging` runs automatically after green `main`, uses `VM_HOST_STAGING`,
  `.env.staging`, and project `brain-staging`.
- `promote_production` depends on staging, waits for the GitHub `production`
  environment approval, uses `VM_HOST`, `.env.prod`, and project `brain-prod`.
- Both jobs ship the same SHA-tagged `brain-core` and `brain-agents` images,
  retag them locally as `brain-core:prod` and `brain-agents:prod`, run
  `tools/migrate up`, then recreate `api`, `worker`, and `agents`.

The forward-only migration rule in [Post-Rollback](#post-rollback) applies to
both environments.

## Current VM Rollback

Rollback on the VM means reusing the rollback image tags captured before the
last deploy overwrote `brain-core:prod` and `brain-agents:prod`.

### Prerequisites

- SSH access to the target VM as `azureuser`.
- Access to the target env file on the host: `.env.staging` or `.env.prod`.
- The failing deploy has run through the workflow, which tags the previous
  images as `brain-core:prod-rollback-<timestamp>` and
  `brain-agents:prod-rollback-<timestamp>` before pulling the new images.
- Rollback images are pruned after 3 days, so rollback targets older than
  that are not guaranteed to exist on the box.

### Procedure

1. SSH to the target VM.

   ```bash
   ssh azureuser@<vm-host>
   cd ~/brain-core
   ```

2. List local rollback images and choose the latest known-good tags.

   ```bash
   docker images brain-core --format '{{.Tag}}\t{{.CreatedAt}}' | sort
   docker images brain-agents --format '{{.Tag}}\t{{.CreatedAt}}' | sort
   ```

3. Repoint `brain-core:prod` and `brain-agents:prod` at the chosen rollback
   images.

   ```bash
   docker tag brain-core:<ROLLBACK_TAG> brain-core:prod
   docker tag brain-agents:<ROLLBACK_TAG> brain-agents:prod
   ```

4. Recreate the runtime services without rebuilding.

   For staging:

   ```bash
   docker compose -p brain-staging \
     --env-file .env.staging \
     -f docker-compose.prod.yml \
     -f docker-compose.caddy.yml \
     --profile agents \
     up -d --no-deps --no-build api worker agents
   ```

   For production:

   ```bash
   docker compose -p brain-prod \
     --env-file .env.prod \
     -f docker-compose.prod.yml \
     -f docker-compose.caddy.yml \
     --profile agents \
     up -d --no-deps --no-build api worker agents
   ```

5. Verify the service health and commit.

   ```bash
   docker compose -p <brain-staging-or-brain-prod> \
     -f docker-compose.prod.yml \
     -f docker-compose.caddy.yml \
     ps

   curl -fsS https://<environment-health-host>/health
   ```

6. Notify the team with the failed commit, rollback tags, symptom, and follow-up
   owner.

## Data And Volumes

The VM stack stores state in named volumes: `pg-data`, `redis-data`, and
`minio-data`. An image rollback does not touch them. Postgres data, Redis state,
and blobs survive.

Never run `docker compose down -v` as part of rollback. The `-v` flag deletes
those volumes.

## Post-Rollback

- Open an incident ticket with the failing revision hash and symptom.
- Migration rollback is not a general-purpose operation. Migrations are
  forward-only. If a migration is the root cause, ship a forward fix through a
  new migration that reconciles state.
- Do not run `tools/migrate down` in staging or production.

## Legacy Azure Notes

The older Azure Container Apps revision-weight rollback model is not the current
production deploy path. `infra/main.tf` still contains legacy Container Apps
wiring, but the GitHub workflow deploys to Docker VMs until that substrate is
explicitly replaced.
