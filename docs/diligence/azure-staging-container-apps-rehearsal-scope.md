# Azure staging Container Apps rehearsal scope

Status: planning only. This document does not authorize a Terraform apply, an
Azure resource creation, a credential or OIDC change, a deployment, a DNS
change, a traffic change, or a feature-flag change.

Date: 2026-08-24

## Decision summary

Create an isolated Azure staging stack before running the validation introduced
by PR #744. The stack should use the same service topology and private-network
dependency paths as production, but every resource, identity, state file,
credential, and data store must be staging-scoped.

Use a dedicated workflow named `deploy-azure-staging.yml`. Do not parameterize
the production workflow for the first rehearsal. Separate hardcoded staging
targets make an accidental production dispatch less likely and make GitHub
environment protection easy to audit. Shared shell helpers may be reused after
their production resource names are replaced with explicit required inputs.

The full staging workload should be ephemeral. Keep only a small staging
foundation between rehearsals: Terraform state, the staging ACR, and the
staging Key Vault. Create the Container Apps environment, apps, jobs, VNet,
Postgres, Managed Redis, Blob account, private endpoints, and Log Analytics for
an approved rehearsal window, then remove them through a separately approved
teardown workflow after evidence is retained.

This recommendation is based on current Canada Central retail rates. An
always-on stack is expected to cost about USD 265 to USD 300 per month at low
traffic, while an 8 to 24 hour rehearsal should cost about USD 15 to USD 30 in
the month it runs. The estimate and assumptions appear below.

## Why the existing staging files are not a target

`infra/poc.tfvars` sets `environment = "staging"`, but it is not a deployable
staging environment:

- It deploys only the API service and omits agents.
- The shared Terraform root also creates auth and worker, so the file's comment
  no longer describes the current topology accurately.
- It has no staging backend configuration.
- `infra/run.sh` always selects `backend-production.hcl` and
  `production.tfvars`.
- `infra/bootstrap/main.tf` emits a production state key and production names.
- `infra/.dockerignore` includes only `backend-production.hcl`.
- `terraform_client_id` and `tfstate_storage_account_id` have production values
  as defaults.
- The Terraform runner grants Contributor and Role Based Access Control
  Administrator at subscription scope. That is too broad for staging.
- `scripts/ops/validate-azure-container-apps.sh` names the production apps and
  production worker directly.
- The only Azure workflow is `deploy-azure-prod.yml`, which names the production
  resource group, ACR, Container Apps environment, apps, and jobs directly.
- The existing GitHub `staging` environment belongs to the VM staging path. It
  does not establish an Azure staging identity or an Azure Container Apps
  target.

A separate Terraform state alone is not sufficient. Each hardcoded production
identity and target must either become an explicit environment input or receive
a separate staging implementation.

## Isolation contract

The staging rehearsal must satisfy every invariant below before its first
apply.

1. Staging has its own Azure resource group and Terraform state resource group.
2. Staging has its own VNet, subnets, private DNS zones, Container Apps
   environment, Postgres server, Managed Redis instance, Blob account, ACR,
   Key Vault, Log Analytics workspace, identities, apps, and jobs.
3. No staging configuration contains a production resource ID, hostname,
   storage account, state key, Key Vault URI, Redis URL, Postgres URL, ACR name,
   application name, job name, or managed identity ID.
4. Staging cannot read or write the production Terraform state.
5. Staging GitHub OIDC and in-VNet Terraform principals have no role assignment
   on `brain-production-rg`, `brain-tfstate-rg`, or a production resource.
6. Production principals receive no new role on a staging resource merely for
   convenience.
7. Staging uses synthetic disposable data only. It never copies VM production,
   Azure production, or Northstar presenter data.
8. Staging never receives production email, OpenAI, payment, Plaid, signing,
   publisher, webhook, or Brain API credentials.
9. Staging has no public Brain DNS name and receives no application traffic.
   Validation uses generated Container Apps FQDNs and internal service FQDNs.
10. On-chain signing and anchor publishing remain disabled. The worker must not
    share a funded production or VM publisher key.
11. Front Door remains disabled. It is not required to validate the MCP route
    at the API boundary.
12. Every rehearsal resource carries tags for `environment=staging`,
    `purpose=deploy-rehearsal`, an owner, an expiry timestamp, and the GitHub
    run ID that created it.

The preferred isolation boundary is a dedicated non-production Azure
subscription. If the organization uses the current subscription instead, both
staging principals must be limited to the staging workload resource group and
the staging state account. Subscription-wide Contributor or Role Based Access
Control Administrator is not acceptable for staging.

## Proposed names and ownership

Names are provisional until a read-only Azure inventory proves that each global
name is available and that no historical proof-of-concept resource would be
adopted accidentally.

| Resource                   | Proposed staging name             | Isolation requirement                         |
| -------------------------- | --------------------------------- | --------------------------------------------- |
| Workload resource group    | `brain-staging-rg`                | Contains no production resources              |
| State resource group       | `brain-staging-tfstate-rg`        | Separate from `brain-tfstate-rg`              |
| Container Apps environment | `brain-staging-env`               | Separate VNet injection and logs              |
| VNet                       | `brain-staging-vnet`              | Non-overlapping CIDR selected after inventory |
| Services identity          | `brain-staging-services`          | Key Vault read and ACR pull only              |
| Terraform runner identity  | `brain-staging-terraform`         | Staging scopes only                           |
| Key Vault                  | `brain-staging-kv`                | Staging secrets only                          |
| Postgres                   | `brain-staging-pg`                | New empty staging database                    |
| Managed Redis              | `brain-staging-redis`             | New private staging cache                     |
| Blob account               | `brainstagingraw`                 | New staging containers and keys               |
| ACR                        | `brainstagingacr`                 | Staging images only                           |
| Log Analytics              | `brain-staging-logs`              | Staging evidence only                         |
| API app                    | `brain-staging-api`               | Generated Azure FQDN only                     |
| Auth app                   | `brain-staging-auth`              | Generated Azure FQDN only                     |
| Worker app                 | `brain-staging-worker`            | No public ingress                             |
| Agents app                 | `brain-staging-agents`            | Internal ingress only                         |
| Terraform job              | `brain-staging-terraform`         | Uses staging state and principal              |
| Migration job              | `brain-staging-migrate`           | Staging Postgres only                         |
| Database roles job         | `brain-staging-db-roles`          | Runs after staging migrations                 |
| Validation job             | `brain-staging-deploy-validation` | Staging dependencies only                     |
| State account              | `brainfitfstatestg`               | Global availability must be checked           |
| State container            | `tfstate-staging`                 | Staging principal access only                 |
| State key                  | `staging.terraform.tfstate`       | Never reused by production                    |

## Terraform structure

### Environment files

Continue using the existing `infra` root so production and staging retain the
same Terraform resource addresses in separate state files. Add:

- `infra/backend-staging.hcl`
- `infra/staging.tfvars`
- an environment-aware replacement for `infra/run.sh`, with an allowlist of
  `staging` and `production`
- staging state bootstrap inputs or a separate `infra/bootstrap-staging` root

Do not use Terraform workspaces. Explicit backend files and separate state
accounts are easier to inspect and harder to confuse during an incident.
Every CI init must use `terraform init -reconfigure` with the selected backend.

The staging tfvars should set at least:

- `environment = "staging"`
- `primary_location = "canadacentral"`
- `services = ["api", "agents"]`
- a staging VNet CIDR proven not to overlap existing Azure networks
- `postgres_sku_name = "B_Standard_B2s"`, subject to an Azure SKU check
- `postgres_storage_mb = 32768`
- `postgres_backup_retention_days = 7`
- `redis_sku_name = "Balanced_B0"`
- `acr_sku = "Basic"`
- `storage_replication_type = "ZRS"`
- `raw_immutability_days` set to the shortest approved synthetic-data period
- `log_retention_days = 30`
- `api_min_replicas = 1` during rehearsal
- `api_max_replicas = 2`
- `enable_frontdoor = false`
- `enable_onchain_signing = false`
- `enable_anchor_publisher = false`
- `enable_demo_provision = false` unless a later signup canary requires it
- a staging issuer based on the staging auth Container App FQDN
- staging-only `terraform_client_id` and `tfstate_storage_account_id`
- the same Base Sepolia contract addresses for read-only boot compatibility,
  with all signing and publishing disabled

The exact Azure Postgres SKU spelling must be taken from the provider and Azure
SKU inventory during implementation. The retail meter calls it `B2S`; the
Terraform provider commonly uses an Azure resource SKU such as
`B_Standard_B2s`. A preflight must fail rather than substitute another SKU.

### Required parameterization

Remove production-specific defaults and require environment-specific values for:

- Terraform runner client ID
- Terraform state storage account ID
- GitHub control-plane target subscription
- auth issuer
- resource names used by control-plane validation
- Log Analytics app names used by worker readiness queries
- backend and tfvars selection inside the Terraform runner image

The control-plane validation helper should accept required environment
variables for API, auth, worker, and agents names. Its tests must prove that a
staging invocation never references `brain-production-*` and a production
invocation never references `brain-staging-*`.

The in-VNet validation job is already derived from Terraform resources and can
be reused. Its run-time inputs must still be read from the staging job and the
expected SHA must come from the staging image build.

### State bootstrap

The staging backend must be created before the main stack. The implementation
plan is:

1. A human approves creation of `brain-staging-tfstate-rg`, the staging state
   account, and the staging state container.
2. Versioning and 30-day blob and container delete retention are enabled.
3. Shared-key access is disabled if supported by the chosen backend flow.
4. The GitHub staging deploy principal and the staging Terraform runner
   principal receive Storage Blob Data Contributor only on the staging state
   account.
5. `backend-staging.hcl` records no secret and selects the staging state key.
6. A read-only identity check proves neither staging principal can list or read
   the production state container.

The backend bootstrap is a separate reviewed operation. It is not bundled into
the first workload apply.

### First-stack bootstrap

The current in-VNet Terraform job cannot create itself from nothing. The first
staging apply therefore needs a reviewed bootstrap sequence:

1. Create or import the already approved staging resource groups.
2. Build the staging ACR and immutable images.
3. Create the VNet, Container Apps environment, Key Vault, private endpoint,
   staging Terraform identity, and Terraform runner job through a narrowly
   scoped bootstrap path.
4. Set the staging Terraform runner credential without printing it.
5. Prove the runner can reach the staging Key Vault and staging backend.
6. Close Key Vault public access and continue all later plans and applies from
   the in-VNet staging runner.

Implementation must document exactly which step temporarily permits Key Vault
data-plane access, who approves it, and how the deny-by-default setting is
verified afterward. A public GitHub runner must not receive ongoing Key Vault
access.

### Staging lifecycle differences

Production safeguards cannot be copied mechanically into an ephemeral stack:

- Production Postgres has `prevent_destroy = true`.
- The state account has `prevent_destroy = true` and should remain protected in
  staging as well.
- Key Vault uses purge protection and soft-delete recovery.
- The provider refuses resource-group deletion when unmanaged resources remain.

Keep `prevent_destroy` for the staging backend. Keep staging Key Vault recovery
protection and retain the vault as part of the persistent foundation. Design the
workload stack so its expensive resources can be removed without deleting the
vault, ACR, or state account. Do not rely on repeated targeted destroys in the
normal workflow.

The implementation should either split foundation and ephemeral workload into
two explicit Terraform roots or add a reviewed staging-only lifecycle boundary.
The choice must be made before the first apply and tested with a complete
create, validate, teardown, and recreate cycle.

## Identity and GitHub environment

### GitHub environment

Create a GitHub environment named `azure-staging-rehearsal`. Do not reuse the
existing `staging` environment, which is associated with VM operations.

Configure:

- required reviewers
- deployment limited to `main` or an explicitly approved rehearsal SHA
- environment-scoped secrets named `AZURE_STAGING_CLIENT_ID`,
  `AZURE_STAGING_TENANT_ID`, and `AZURE_STAGING_SUBSCRIPTION_ID`
- environment-scoped variables for resource group, ACR, Container Apps
  environment, app names, job names, region, and expected subscription ID
- no production Azure credential names as a fallback

The workflow must fail before login if any staging value is absent, and fail
after login unless the actual subscription ID matches the environment's
expected staging subscription ID.

### GitHub OIDC principal

Create a dedicated Entra application and service principal such as
`brain-github-azure-staging`. Its federated credential must bind exactly to:

```text
repo:braindotfi/brain-core:environment:azure-staging-rehearsal
```

Use the Azure token-exchange audience and no client secret. Scope its roles to
the pre-created staging workload resource group, staging state resource group,
and staging ACR build operations. If the resource groups must be created by the
workflow, use a one-time bootstrap principal or a narrowly reviewed custom role
rather than granting the recurring deploy principal subscription-wide rights.

### In-VNet Terraform principal

Create a second staging-only principal for the in-VNet Terraform job. It must
not reuse the GitHub OIDC principal or the production Terraform principal. Its
credential is stored only in the staging Key Vault and resolved by the staging
Terraform job's managed identity.

Grant only:

- Contributor on the staging workload resource group
- Role Based Access Control Administrator on the staging workload resource
  group if Terraform must create role assignments
- Storage Blob Data Contributor on the staging state account
- Key Vault data-plane access on the staging vault
- ACR pull on the staging registry

Add a negative-access rehearsal that proves this principal cannot read the
production resource group, production Key Vault, production ACR, or production
state.

## Staging secrets

The staging Key Vault should use the same secret names and managed-identity
resolution paths as production, but values must be independent.

Terraform may generate staging database role passwords, cookie secrets, HMAC
secrets, the API-key pepper, and the source-credential encryption key.

Human or separately gated automation must supply:

- a staging auth signing JWK
- a staging-only OpenAI key with a low spend cap, or an approved non-production
  provider credential
- a staging agent API token scoped only to a disposable staging tenant
- staging email configuration that cannot send to arbitrary recipients
- the staging Terraform runner credential

Do not set a session key or anchor publisher key while those features are
disabled. The validation job should check only secrets consumed by enabled
features, matching PR #744's current behavior.

Every secret value remains absent from Terraform plans, workflow output, logs,
artifacts, and validation summaries.

## Workflow design

Add `.github/workflows/deploy-azure-staging.yml`. Its first implementation
should be separate from `deploy-azure-prod.yml` even where steps are similar.
After both workflows have passed review, shared behavior may move into scripts
or a reusable workflow with explicit target inputs.

### Inputs

- full release SHA, defaulting to current `main`
- `plan` or `apply`, defaulting to `plan`
- build-images boolean
- run-migrations boolean, valid only with `apply`
- lifecycle action limited to `rehearse` in the deploy workflow

Teardown belongs in a separate `teardown-azure-staging.yml` workflow with its
own approval, plan evidence, and protected-resource checks. The deploy workflow
must never accept `destroy` as a free-form Terraform action.

### Preflight

1. Resolve a full lowercase 40-character SHA.
2. Prove the SHA is reachable from `main`.
3. Authenticate through `azure-staging-rehearsal` OIDC.
4. Prove the Azure subscription ID is the expected staging subscription.
5. Prove the resource group and every discovered resource carry staging tags.
6. Fail if any target name or resource ID contains `production` or equals a
   production allow-deny inventory entry.
7. Prove the backend account and state key are staging-only.
8. Prove the ACR is the staging registry before building.
9. Run a Terraform plan and retain the redacted plan summary.
10. Require a human approval for apply after the plan has been reviewed.

### Build and apply

1. Build API, agents, database-roles, and Terraform runner images in the
   staging ACR.
2. Pass the full `GIT_SHA` build argument to API and agents images.
3. Tag with the short SHA and select only that immutable tag for deployment.
4. Start the staging in-VNet Terraform runner with the staging backend, staging
   tfvars, image tag, and full SHA.
5. Run staging migrations, then staging database roles.
6. Run control-plane readiness with staging app names.
7. Start `brain-staging-deploy-validation` with a unique run ID.
8. Retrieve redacted per-gate evidence even when validation fails.
9. Stop on any failed gate. Do not repair or retry automatically.

Candidate revision behavior remains a separate prerequisite for production.
The staging rehearsal should exercise candidate or non-serving revision
validation once that behavior exists, but staging itself receives no real
traffic and therefore cannot substitute for the production traffic-promotion
gate.

## PR #744 validation gates in staging

The rehearsal report must include one row per gate, with execution ID,
correlation ID, duration, and redacted detail.

| Gate              | Required staging proof                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Immutable release | API, auth, worker, and agents run the selected image tag and report the exact full SHA where a health surface exists                |
| API               | `/health` reports `ok:true`, `brain-api`, and exact SHA                                                                             |
| Auth              | `/healthz`, authorization-server metadata, and JWKS are valid and report the exact SHA                                              |
| Worker            | Correct image, healthy replica, zero restart loop, and recent `brain-server up` evidence                                            |
| Agents            | Internal health succeeds from the validation job and reports the exact SHA                                                          |
| MCP               | Protected-resource discovery is correct and unauthenticated initialization returns the expected bearer challenge                    |
| Managed Redis     | TLS PING, namespaced set, get, TTL, delete, and one-time BullMQ delivery all pass                                                   |
| Key Vault mounted | Every enabled required secret reference resolves and no placeholder is mounted                                                      |
| Key Vault direct  | Managed identity loads the 32-byte source-credential key by name                                                                    |
| Blob              | A disposable object is written, read, SHA-256 checked, and removed from `deploy-validation`                                         |
| Postgres          | All service roles connect over TLS, tenant tables have forced RLS, dummy-tenant reads isolate, and the MCP reader cannot update Raw |
| Evidence          | A redacted `azure_deploy_validation` summary exists and reports every required gate as successful                                   |

The existing PR #744 validation does not perform a database-backed auth signup,
an authorized MCP tenant read, a durable worker canary, or a full agents
provider round trip. Those remain explicit follow-up gaps in the production
validation scope and must not be described as covered by this rehearsal.

## Evidence and stop conditions

Retain:

- GitHub run URL and approved SHA
- Azure subscription ID in redacted form or as an approved non-secret ID
- Terraform plan and apply execution IDs
- staging image digests and tags
- revision names, replica counts, restart counts, and traffic weights
- migration and database-role job execution IDs
- validation job execution ID
- one redacted result per gate
- cleanup confirmation for Redis keys, BullMQ queue, Blob object, and test data
- staging teardown plan and execution evidence when separately approved

Stop immediately and report without repair when:

- target isolation cannot be proven
- an identity has production access
- any production resource ID appears in plan or runtime configuration
- a plan replaces an unapproved protected resource
- a secret is missing, disabled, placeholder, or logged
- image SHA or tag differs from the requested release
- migration or database-role execution fails
- any validation gate fails or lacks evidence
- cleanup of a disposable canary fails

## Cost estimate

### Sources and date

Rates were read from the official Azure Retail Prices API on 2026-08-24 for
Canada Central in USD. Supporting service pages:

- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
- [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)
- [Azure Managed Redis pricing](https://azure.microsoft.com/en-us/pricing/details/managed-redis/)
- [Azure Database for PostgreSQL pricing](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/)
- [Azure Key Vault pricing](https://azure.microsoft.com/en-us/pricing/details/key-vault/)
- [Azure Private Link pricing](https://azure.microsoft.com/en-us/pricing/details/private-link/)
- [Azure Container Registry pricing](https://azure.microsoft.com/en-us/pricing/details/container-registry/)
- [Azure Blob Storage pricing](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/)

Retail rates are estimates, not a quote. They exclude negotiated discounts,
tax, support, unexpected egress, external API use, and price changes. The
Container Apps monthly free grant is not credited because a shared subscription
may already consume it.

### Rates used

| Meter                                |                                      Rate used |
| ------------------------------------ | ---------------------------------------------: |
| Container Apps active vCPU           |                   USD 0.000034 per vCPU-second |
| Container Apps idle vCPU             |                   USD 0.000004 per vCPU-second |
| Container Apps active or idle memory |                    USD 0.000004 per GiB-second |
| Managed Redis Balanced B0            |                             USD 0.017 per hour |
| PostgreSQL Flexible Server B2s       |                             USD 0.074 per hour |
| PostgreSQL storage                   |                        USD 0.1265 per GB-month |
| Private endpoint                     |                              USD 0.01 per hour |
| ACR Basic                            |                             USD 0.1666 per day |
| Log Analytics ingestion              | USD 2.76 per GB after any applicable allowance |
| Key Vault operations                 |                 USD 0.03 per 10,000 operations |
| Hot ZRS Blob capacity                | about USD 0.025 per GB-month at the first tier |

### Always-on model

Assumptions:

- API and worker use 1 vCPU and 2 GiB each.
- Auth and agents use 0.5 vCPU and 1 GiB each.
- Each app keeps one minimum replica.
- Worker bills at the active rate while background lanes run.
- API, auth, and agents are mostly idle.
- PostgreSQL uses B2s with 32 GB storage.
- Redis uses Balanced B0.
- Two private endpoints remain active.
- ACR Basic, 10 GB Blob, and about 1 GB monthly Log Analytics ingestion.

| Component                                             | Approximate monthly USD |
| ----------------------------------------------------- | ----------------------: |
| Container Apps, absolute all-idle floor               |                      95 |
| Container Apps, worker active and other apps idle     |                     173 |
| Container Apps, all four apps active continuously     |                     331 |
| PostgreSQL B2s compute and 32 GB storage              |                      58 |
| Managed Redis B0                                      |                      12 |
| Two private endpoints                                 |                      15 |
| ACR Basic                                             |                       5 |
| Blob, Key Vault, and low-volume logs                  |                  3 to 8 |
| Total at absolute idle floor                          |               about 190 |
| Expected low-traffic total                            |        about 265 to 300 |
| Upper bound with all app replicas continuously active |               about 425 |

### Ephemeral rehearsal model

Assumptions:

- Retain only staging state, ACR, and Key Vault between rehearsals.
- Run the full workload for 8 to 24 hours.
- Bill app replicas at active rates during the window.
- Use one B2s Postgres server, one Redis B0 instance, and two private endpoints.
- Store only synthetic validation data.
- Include a small allowance for image builds, logs, and storage operations.

| Window                             | Approximate USD per rehearsal month |
| ---------------------------------- | ----------------------------------: |
| 8 hours                            |                            15 to 20 |
| 24 hours                           |                            20 to 30 |
| Persistent foundation between runs |             about 5 to 10 per month |

Provisioning delays, failed runs, retained logs, and external provider calls can
increase those figures. Add a staging budget alert at USD 25 and USD 50, plus an
expiry-policy alert when workload resources remain after the approved window.

## Recommended sequencing

1. Review and approve this scope.
2. Decide dedicated subscription versus same-subscription resource-group
   isolation.
3. Choose foundation plus ephemeral workload Terraform boundaries.
4. Implement staging backend bootstrap and staging tfvars.
5. Implement staging GitHub environment and both staging identities.
6. Implement the separate staging deploy workflow and parameterized validation
   helper.
7. Run static tests and Terraform plans only.
8. Approve the one-time staging foundation creation.
9. Approve one ephemeral staging workload apply.
10. Run PR #744's validation matrix and report every gate.
11. Approve and run staging workload teardown.
12. Recreate and rerun once to prove the environment is reproducible.
13. Review evidence before authorizing any production Container Apps action.

## Done and pending checklist

- [x] Confirmed no runnable Azure staging rehearsal target exists.
- [x] Inventoried the production Terraform topology and PR #744 validation job.
- [x] Identified production values and names that must be parameterized.
- [x] Defined staging resource, state, identity, data, and credential isolation.
- [x] Scoped a separate staging workflow and per-gate evidence requirements.
- [x] Estimated always-on and ephemeral cost from current official Azure rates.
- [x] Recommended an ephemeral workload with a small persistent foundation.
- [ ] Approve subscription and resource-group isolation choice.
- [ ] Approve foundation and ephemeral Terraform state boundaries.
- [ ] Implement `backend-staging.hcl` and `staging.tfvars`.
- [ ] Remove production defaults from environment-specific Terraform inputs.
- [ ] Parameterize control-plane validation app and worker names.
- [ ] Implement staging backend bootstrap.
- [ ] Create the staging GitHub environment.
- [ ] Create staging GitHub OIDC and Terraform runner principals.
- [ ] Configure staging-only secrets and variables.
- [ ] Implement `deploy-azure-staging.yml`.
- [ ] Implement a separately approved staging teardown workflow.
- [ ] Prove static Terraform and workflow tests.
- [ ] Approve and create the staging foundation.
- [ ] Run the first isolated staging rehearsal.
- [ ] Report every PR #744 validation gate.
- [ ] Tear down the staging workload and retain evidence.
- [ ] Recreate and rerun to prove reproducibility.
- [ ] Review production candidate-revision behavior separately.

Until every implementation and rehearsal item above is complete, do not run
`deploy-azure-prod.yml` with `terraform_action=apply` and do not make a
production Container Apps, VM, DNS, traffic, credential, or feature-flag
change.
