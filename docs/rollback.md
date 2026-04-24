# Rollback runbook

§10.3: "Rollback is one command: `az containerapp revision set-active --revision N-1`."

## Prerequisites

- Azure CLI authenticated with an identity that has `Container Apps
  Contributor` on the resource group.
- Resource group: `brain-production-rg` (or `brain-staging-rg`).
- Know the service that needs rollback (usually `api`, but any of the
  seven services).

## Procedure

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

## Post-rollback

- Open an incident ticket with the failing revision hash and the symptom
  that caused the rollback. §11.1 requires a post-mortem on every
  production rollback.
- Migration rollback is NOT a general-purpose operation: §10.5 mandates
  forward-compatible migrations. If a migration is the root cause, the
  fix is forward — a new migration that reconciles state — never a
  reverse migration.
