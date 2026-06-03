# Rollback Runbook

Brain runs on two substrates with different rollback mechanics:

- **Azure Container Apps** (managed staging/production) — revision-based; see
  [§A](#a-azure-container-apps).
- **Single-host Docker** (testnet dev-live VM, `docker-compose.prod.yml`) —
  image-tag based; see [§B](#b-single-host-docker-testnet-dev-live).

The forward-only migration rule in [Post-Rollback](#post-rollback) applies to
both.

---

## A. Azure Container Apps

§10.3: "Rollback is one command: `az containerapp revision set-active --revision N-1`."

### Prerequisites

- Azure CLI authenticated with an identity that has `Container Apps
Contributor` on the resource group.
- Resource group: `brain-production-rg` (or `brain-staging-rg`).
- Know the service that needs rollback (usually `api`, but any of the
  seven services).

### Procedure

1. Identify the currently-active revision:

   ```bash
   az containerapp revision list \
     --name brain-production-api \
     --resource-group brain-production-rg \
     --query "[?properties.active].name" -o tsv
   ```

2. Identify the previous revision (N-1) by `createdTime`:

   ```bash
   az containerapp revision list \
     --name brain-production-api \
     --resource-group brain-production-rg \
     --query "sort_by([], &properties.createdTime)[-2].name" -o tsv
   ```

3. Shift traffic to N-1:

   ```bash
   az containerapp ingress traffic set \
     --name brain-production-api \
     --resource-group brain-production-rg \
     --revision-weight <REVISION_N-1>=100
   ```

4. Verify:

   ```bash
   az containerapp ingress traffic show \
     --name brain-production-api \
     --resource-group brain-production-rg
   ```

5. Notify on-call via PagerDuty with the revision hashes and the reason.

---

## B. Single-host Docker (testnet dev-live)

The testnet VM runs the stack from `docker-compose.prod.yml`, which builds a
local `brain-core:prod` image. Rollback here means **re-pinning the `api` (and
`migrate`) service to a previously-built, known-good image tag** — there is no
revision controller, so the image tag IS the unit of rollback.

### Prerequisites

- SSH access to the VM and membership in the `docker` group.
- A known-good image tag to roll back to. **This only works if images were
  tagged at deploy time** — see [Tagging discipline](#tagging-discipline) below.
  Without prior tags, the only "rollback" is `git checkout <good-sha>` +
  rebuild, which is slow and rebuilds from source.

### Procedure

1. List locally-available image tags and pick the previous good one:

   ```bash
   docker images brain-core --format '{{.Tag}}\t{{.CreatedAt}}'
   ```

2. Re-pin the `api`/`migrate` image tag. The compose file resolves the image as
   `brain-core:${BRAIN_IMAGE_TAG:-prod}`, so a rollback is a single env override
   — no file edit:

   ```bash
   BRAIN_IMAGE_TAG=<GOOD_TAG> \
     docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --no-build api
   ```

   `--no-build` is critical — it recreates the container from the existing
   tagged image instead of rebuilding the current (bad) source. (Set
   `BRAIN_IMAGE_TAG` in `.env.prod` to make the pin sticky across later
   `up` invocations.)

3. Confirm the new container is healthy (the image carries a `/health`
   HEALTHCHECK):

   ```bash
   docker compose -f docker-compose.prod.yml ps        # api → healthy
   curl -fsS http://localhost:3000/health
   ```

4. Do **not** roll back the `migrate`/`db-roles` one-shots to "undo" a
   migration — migrations are forward-only (see Post-Rollback). Rolling the
   `api` image back to a build whose code predates a migration is safe as long
   as the migration is forward-compatible (it must be, per §10.5).

### Tagging discipline

Rollback is only possible if good images exist. At deploy time, tag the build
with the git sha before promoting it to `:prod`:

```bash
GIT_SHA=$(git rev-parse --short HEAD)
docker compose --env-file .env.prod -f docker-compose.prod.yml build api
docker tag brain-core:prod brain-core:$GIT_SHA   # keep an addressable history
```

Keep at least the last 2–3 sha-tagged images on the VM so a one-command
re-pin is always available. Prune older ones with `docker image prune`.

### Data & volumes

The stack's state lives in named volumes (`pg-data`, `redis-data`,
`minio-data`). An image rollback does **not** touch them — Postgres data,
Redis state, and blobs survive. Never `docker compose down -v` as part of a
rollback; `-v` deletes those volumes.

---

## Post-Rollback

- Open an incident ticket with the failing revision hash and the symptom
  that caused the rollback. §11.1 requires a post-mortem on every
  production rollback.
- Migration rollback is NOT a general-purpose operation: §10.5 mandates
  forward-compatible migrations. If a migration is the root cause, the
  fix is forward, a new migration that reconciles state, never a
  reverse migration.
