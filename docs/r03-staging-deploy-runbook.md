# R-03 Staging Deploy Runbook

This runbook describes the current staging-first VM deployment path. It replaces
the older Azure Container Apps staging plan for day-to-day deploy operations.

Goal: every green merge to `main` deploys the same built image to staging, proves
the live `/health` commit, and then leaves production behind a manual GitHub
environment approval.

## Current Deployment Shape

The main workflow has three deployment jobs after quality gates:

1. `build_image` builds one root Docker image with `GIT_SHA=${{ github.sha }}` and
   uploads `brain-core-prod-${{ github.sha }}` as a short-lived artifact.
2. `deploy_staging` downloads that artifact, ships it to the staging VM, runs
   migrations, recreates `api`, `worker`, and `agents`, and checks the staging
   health endpoint for the same commit.
3. `promote_production` depends on staging and is bound to the GitHub
   `production` environment. It waits for a required reviewer before deploying
   the same image artifact to `api.brain.fi`.

Production must never deploy directly from a bare push. The production
environment approval is the manual promote gate.

## One-Time Staging Setup

1. Provision a staging VM with Docker, Docker Compose, SSH access for the deploy
   key, and a copied `~/brain-core` tree containing:
   - `docker-compose.prod.yml`
   - host-only `docker-compose.caddy.yml`
   - host-only `.env.staging`

2. Add GitHub Actions secrets:

   | Name                 | Purpose                            |
   | -------------------- | ---------------------------------- |
   | `VM_HOST_STAGING`    | staging VM hostname or IP          |
   | `VM_SSH_KEY_STAGING` | SSH private key for the staging VM |
   | `VM_HOST`            | production VM hostname or IP       |
   | `VM_SSH_KEY`         | SSH private key for production VM  |

3. Add optional GitHub Actions variable:

   | Name                       | Default                               |
   | -------------------------- | ------------------------------------- |
   | `BRAIN_STAGING_HEALTH_URL` | `https://staging-api.brain.fi/health` |

4. Create the GitHub `production` environment and require reviewer approval.

5. Populate `.env.staging` and `.env.prod` on their hosts. Both files must
   include:
   - `OPENAI_API_KEY`
   - `DOCUMENT_EXTRACT_AGENT_URL=http://agents:8001`
   - `BRAIN_AGENTS_INBOUND_SECRET`
   - ESP credentials for outbound email onboarding
   - the normal production-mode database, auth, rail, blob, and on-chain values

## Deploy Flow

Merge to `main` or manually re-run the `main` workflow.

Expected order:

```text
unit_and_integration
golden_path_smoke
python_agents
build_image
deploy_staging
promote_production waits for production approval
```

Staging is healthy when `deploy_staging` passes the commit-matching health
check. Production is healthy when `promote_production` passes
`https://api.brain.fi/health` with the same commit.

## Verification

After staging deploys, run:

```bash
pnpm run production-readiness --profile staging
pnpm run readiness:evidence -- --profile staging
```

Attach the readiness evidence artifact to release-candidate notes when promoting
significant changes.

For document extraction, verify the API can reach the agents service at
`http://agents:8001` from inside the compose network. The workflow recreates
`api`, `worker`, and `agents` together with `--profile agents`.

## Rollback

Use [Rollback Runbook](./rollback.md). The current rollback unit is the Docker
image tag on the target VM, not an Azure Container Apps revision.

## Legacy Terraform Notes

`infra/main.tf` still contains Azure Container Apps wiring from an earlier
deployment model. Treat it as legacy until a dedicated infra migration replaces
the VM workflow. The current source of truth for staging and production deploys
is `.github/workflows/main.yml`.
