# Audit #14 — Infrastructure (Terraform + docker-compose)

**Subsystem**: `infra/` (Terraform, Azure), `docker-compose.yml`, `Dockerfile`, `.github/workflows/main.yml`
**Auditor**: Evidence-driven, commands executed 2026-05-26
**Status**: Complete
**Score**: 5 / 10

---

## 1. Scope

This audit covers:
- `docker-compose.yml` — local dev stack (Postgres, Redis, LocalStack, agents)
- Root `Dockerfile` — production container (Node monolith)
- `infra/main.tf` — Azure Terraform resources (Container Apps, Postgres, Redis, Blob, Key Vault, ACR, Front Door)
- `infra/variables.tf`, `infra/versions.tf`, `infra/poc.tfvars` — Terraform config
- `infra/db-roles.sql` — database role model (deploy artifact)
- `.github/workflows/main.yml` — build, deploy, promote pipeline
- Alignment between Terraform, the runtime (what `main.ts` actually needs), and the deploy pipeline

Out of scope: live Terraform state (no Azure credentials), live Docker builds, Front Door WAF policy.

---

## 2. docker-compose: Local Dev Stack

### Services

| Container | Image | Port | Role |
|-----------|-------|------|------|
| `brain-postgres` | `pgvector/pgvector:pg16` | 5432 | Primary DB (pgvector bundled) |
| `brain-redis` | `redis:7-alpine` | 6379 | BullMQ queues + idempotency cache |
| `brain-localstack` | `localstack/localstack:3` | 4566 | S3 emulation (Azure Blob equivalent in dev) |
| `brain-agents` | Built from `services/agents/Dockerfile` | 8001 | Python agents container |

### Assessment

**Postgres**: correct image, pgvector included, healthcheck via `pg_isready`. `tools/postgres-init/01-extensions.sql` enables `vector` and `pgcrypto` at init time. Clean.

**Redis**: Redis 7 Alpine, AOF persistence enabled (`--appendonly yes`), healthcheck via `redis-cli ping`. Clean.

**LocalStack**: S3 only (`SERVICES: s3`), persistence enabled. Models Azure Blob Storage via LocalStack S3 compatibility. The `BlobAdapter` wraps S3-compatible client, so the abstraction holds in dev. Clean.

**Agents**: Two confirmed gaps from Audit #12 are visible here:
- `BRAIN_API_BASE_URL: ${BRAIN_API_BASE_URL:-http://host.docker.internal:3001}` — default port 3001; TS API listens on 3000 (F-12-C)
- `healthcheck: CMD ["curl", "-f", "http://localhost:8001/health"]` — `curl` absent in `python:3.12-slim` (F-12-A)

**TS API container is not in docker-compose.** The compose file boots infrastructure only. Developers run `node services/api/dist/main.js` (or the dev server) locally. This is documented behavior (`dev:up` / `dev:down`).

---

## 3. Root Dockerfile

### Structure

Two-stage build:

```
builder stage (node:22-slim):
  corepack enable → pnpm@9.12.0
  COPY workspace manifests (layer cache)
  pnpm install --frozen-lockfile
  COPY . .
  pnpm run build
  → produces dist/ for all TS workspaces

runtime stage (node:22-slim):
  pnpm install --frozen-lockfile --prod (dev deps excluded)
  COPY --from=builder dist/ for:
    schemas, shared, api, raw, ledger, wiki, policy, execution, mcp, audit, clients/sdk, tools/migrate
  EXPOSE 3000
  USER node
  HEALTHCHECK: node -e "fetch('http://localhost:'+PORT+'/health')"
  CMD: node services/api/dist/main.js
```

### Assessment

Clean multi-stage build with layer caching. The `--prod` install in the runtime stage correctly strips dev dependencies. Healthcheck uses Node's built-in `fetch` (Node 22 native) — no curl dependency, no shell required. Port correct (`3000` matching `.env.example`).

**Missing workspaces in Dockerfile**: `services/agent-router` and `services/internal-agents` are not explicitly listed in the Dockerfile `COPY` steps. However, both are `private: true` packages with no standalone dist — they are imported as workspace deps by `@brain/api`, so their built output lands under the transitive copy. This is fine **only if** `pnpm install` resolves workspace symlinks correctly in the runtime stage. Since only `package.json` files (not `tsconfig.json`) are copied for the runtime install, this should work — but if `agent-router` or `internal-agents` ever need their own `dist/` copy, the Dockerfile needs updating.

**Note**: The root Dockerfile produces ONE image (`brain-api:latest`). All TS services are bundled into this single process. The Terraform provisions separate Container Apps per service, but only the `api` app is actually updated in the deploy pipeline (see §5).

---

## 4. Terraform Resource Inventory

### What is provisioned

| Resource | Type | Notes |
|----------|------|-------|
| Resource group (primary) | `azurerm_resource_group` | `eastus` default |
| Resource group (backup) | `azurerm_resource_group` (prod only) | `westus3`, cross-region |
| Managed identity | `azurerm_user_assigned_identity` | Pulls secrets + images |
| Key Vault | `azurerm_key_vault` | RBAC mode, purge protection (prod only) |
| Postgres Flexible Server | `azurerm_postgresql_flexible_server` | PG 16, pgvector extension allowlisted, no public network |
| Postgres DB | `azurerm_postgresql_flexible_server_database` | `brain`, UTF8 |
| Postgres extensions | `azurerm_postgresql_flexible_server_configuration` | `VECTOR,PGCRYPTO,UUID-OSSP` |
| Redis | `azurerm_redis_cache` | SSL-only, TLS 1.2+, Premium (prod) / Basic (staging) |
| Blob storage | `azurerm_storage_account` | GRS (prod) / LRS (staging), immutable blob policy |
| Blob containers | `azurerm_storage_container` | `raw-artifacts` (7yr immutable prod), `audit-exports` |
| Container Registry | `azurerm_container_registry` | Premium (prod) / Standard (staging), admin disabled |
| Log Analytics workspace | `azurerm_log_analytics_workspace` | 90d (prod) / 30d (staging) retention |
| Container Apps environment | `azurerm_container_app_environment` | wired to Log Analytics |
| Container Apps (×N) | `azurerm_container_app` | `for_each = var.services` |
| Front Door profile | `azurerm_cdn_frontdoor_profile` | Premium (prod) / Standard (staging) |
| KV secrets | `azurerm_key_vault_secret` | `database-url`, `redis-url`, `postgres-admin-password` |

### What is NOT provisioned

- Front Door origin groups, routes, and WAF policy — `main.tf:300–302`: "See ./frontdoor.tf in the post-stage-8 bundle." **`frontdoor.tf` does not exist in `infra/`.** The Front Door profile is created but is non-functional (no traffic routing configured).
- VNET / private endpoints — Postgres has `public_network_access_enabled = false`, but no `azurerm_private_endpoint` resource exists. Without a private endpoint, Postgres is unreachable from the Container Apps.
- DNS zone / custom domain — no `azurerm_dns_*` or Front Door custom domain resources.
- Azure Monitor diagnostic settings / Datadog integration — header comment promises these but no resources exist.
- Backup/PITR configuration — no `azurerm_postgresql_flexible_server_configuration` for backup retention.

---

## 5. Critical Gaps

### Gap 1: Container App target port 8080 vs API port 3000 (SEVERITY: Critical)

```hcl
ingress {
  external_enabled = each.key == "api"
  target_port      = 8080
```

The root Dockerfile exposes port `3000`. `.env.example` sets `PORT=3000`. The API reads `cfg.PORT || 3000`.

Azure Container Apps routes inbound traffic to `target_port`. With `target_port = 8080`, the platform sends traffic to port 8080. The app listens on 3000. All inbound requests fail (connection refused). The staging deployment is unreachable.

**Fix**: Change `target_port = 8080` to `target_port = 3000`, or inject `PORT=8080` as an env var in the Container App template.

### Gap 2: Terraform injects only 4 of ~20 required env vars (SEVERITY: Critical)

The Container App template injects:
- `NODE_ENV` (from `var.environment`)
- `SERVICE_NAME` (hardcoded pattern)
- `DATABASE_URL` (from Key Vault secret)
- `REDIS_URL` (from Key Vault secret)

Missing from Terraform (full list from `.env.example`):

| Variable | Impact if missing |
|----------|------------------|
| `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` | JWT auth fails — every authenticated request rejected |
| `OPENAI_API_KEY` | Wiki Q&A and Python agents fail |
| `ANTHROPIC_API_KEY` | Any Claude-backed feature fails |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | ACH rails fail at dispatch |
| `RPC_URL`, `AUDIT_ANCHOR_ADDRESS` | On-chain anchor broadcasts fail |
| `MCP_AGENT_REGISTRY_ADDRESS`, `POLICY_REGISTRY_ADDRESS` | On-chain scope check and policy signer fail |
| `BRAIN_DEMO_MODE` | Demo mode toggle absent |
| `WIKI_LLM_MODEL`, `WIKI_EMBED_MODEL` | Wiki uses defaults (gpt-4o-mini) — tolerable |
| `PLAID_ENV` | Plaid uses wrong environment |
| `AUDIT_ANCHOR_INTERVAL_MS` | Anchor cadence uses hardcoded default |
| `PRIVILEGED_DATABASE_URL` | All BYPASSRLS paths use the single DATABASE_URL (not split yet) |

A staging deployment with only these 4 variables will boot but all authentication will fail immediately.

### Gap 3: Terraform remote state is commented out (SEVERITY: High)

`infra/versions.tf:22–28`:
```hcl
# Remote state wired in stage-8. Using local backend during scaffolding only.
# backend "azurerm" {
#   resource_group_name  = "brain-tfstate"
#   storage_account_name = "braintfstate"
#   ...
# }
```

State is stored locally. Running `terraform apply` from CI or a second machine creates a new independent state, risking resource drift or duplicate provisioning. The named storage account (`braintfstate`) and resource group (`brain-tfstate`) are referenced but not provisioned by this Terraform (catch-22 — they must be manually created before uncommenting).

### Gap 4: `frontdoor.tf` referenced but missing (SEVERITY: High)

The Front Door profile is provisioned but has no origins, origin groups, routes, or rules. Public API traffic cannot be routed through Front Door. The staging URL `api.sandbox.brain.fi` (referenced in `main.yml:209`) has no corresponding DNS or Front Door configuration.

### Gap 5: Postgres private networking incomplete (SEVERITY: High)

`public_network_access_enabled = false` on the Postgres server is correct security posture, but no `azurerm_private_endpoint` is provisioned. The Container Apps environment is in the same `azurerm_container_app_environment` but without a dedicated VNET injection or private endpoint, the apps cannot reach the Postgres server. The staging deployment cannot connect to its database.

### Gap 6: Terraform services list vs monolithic deploy reality (SEVERITY: Medium)

`variables.tf` default: `services = ["api", "raw", "wiki", "policy", "execution", "audit", "agents"]`

The deploy pipeline (`main.yml:197`) only updates `api`:
```bash
for svc in api; do
  az containerapp update --name "brain-staging-$svc" ...
done
```

Seven Container Apps are provisioned; only one is updated on each deploy. The other six apps (`raw`, `wiki`, `policy`, `execution`, `audit`, `agents`) are created but never updated. They would run `brain-raw:latest`, etc., which all point at the same single-process boot binary (the root Dockerfile). The Python agents app (`brain-staging-agents`) points at `brain-agents:latest` — the correct Python image — but it's never updated by the CI pipeline.

`poc.tfvars` correctly narrows this to `services = ["api"]` for the investor demo. But the default `variables.tf` will over-provision in staging unless `poc.tfvars` is always used.

### Gap 7: `db-roles.sql` has no automation path (SEVERITY: Medium)

`infra/db-roles.sql` is a critical security artifact (defines `brain_app` / `brain_privileged` roles, applies FORCE RLS). It must be run once as superuser. There is no:
- Terraform `null_resource` or `postgresql_*` provider resource to apply it
- CI pipeline step
- `tools/migrate` integration (the file explicitly notes it is NOT a migration)

The file relies on `:'brain_app_password'` and `:'brain_privileged_password'` psql variables (substituted by a deploy pipeline step that doesn't exist). Without this, production uses the `brain_admin` owner role for all queries — RLS is armed but not enforced.

---

## 6. CI Pipeline (main.yml)

### Build → Deploy → E2E → Promote

```
push to main:
  build_and_push_images (matrix: api, raw, wiki, policy, execution, audit, agents)
    → docker build -f Dockerfile (root) for all TS services
    → docker build -f services/agents/Dockerfile for agents
    → push to ACR: brain-{svc}:{sha} + brain-{svc}:latest

  deploy_staging:
    → az containerapp update --name brain-staging-api --image brain-api:{sha}
    (raw, wiki, policy, execution, audit, agents: NOT updated)

  e2e_staging:
    → pnpm -r --filter='./tests/e2e' run test
    → BRAIN_BASE_URL: https://api.sandbox.brain.fi/v1

  promote_production (manual approval gate):
    → revision weights: 0% → 10% → 100%
```

### Pipeline gaps

1. **Python agents image**: The build matrix includes `agents`, but the matrix iterates over services using the root Dockerfile for all entries — unless the matrix dynamically selects the Dockerfile. The main.yml build step is not fully shown but given the comment "All 8 images," it appears both the Node monolith and Python container are built. Verification: `services/agents/Dockerfile` exists and is referenced from docker-compose; it must be explicitly specified in the matrix build step.

2. **E2E target URL `api.sandbox.brain.fi`**: This URL is referenced but no DNS or Front Door origin is configured (Gap 4). The e2e tests would fail with a connection error unless the URL is manually configured out-of-band.

3. **No Terraform plan/apply in CI**: The pipeline has no `terraform plan` or `terraform apply` step. Infrastructure changes are applied manually. There is no infrastructure-as-code gate in the PR pipeline.

---

## 7. Functional Status

| Component | Status |
|-----------|--------|
| docker-compose (postgres, redis, localstack) | Working — used in development |
| docker-compose agents | Broken (curl healthcheck, port mismatch) — from Audit #12 |
| Root Dockerfile | Structurally correct; NODE_ENV/PORT alignment with Terraform needs fix |
| Terraform resource definitions | Structurally correct for declared resources |
| Terraform env var injection | Critical gap — 4 of ~20 required vars |
| Container App target port | **Broken** — 8080 vs API 3000 |
| Front Door routing | **Non-functional** — frontdoor.tf missing |
| Private networking | **Incomplete** — no private endpoint for Postgres |
| Remote state | **Local only** — commented out |
| db-roles.sql automation | **Manual only** — no CI or Terraform path |

---

## 8. Production Readiness

**Score: 5 / 10**

The Terraform covers the right resources for a cloud-native Azure deployment. The architectural decisions (managed identity, Key Vault secrets, immutable blob, Redis TLS, private Postgres) are correct. The implementation gaps are numerous and collectively block a working staging deployment.

| Dimension | Assessment |
|-----------|-----------|
| Resource coverage | Good — all required Azure resources modeled |
| Security posture | Good — managed identity, Key Vault, no admin, TLS enforced |
| Runtime alignment | **Critical gaps** — port 8080 vs 3000, 16 missing env vars |
| Networking | Incomplete — no private endpoints |
| Remote state | Not configured — local only |
| Front Door | Non-functional — no routes |
| CI/CD | Deploy partial (api only) |

---

## 9. Confidence

| Area | Confidence | Reason |
|------|-----------|--------|
| Terraform resource list | High | Full `main.tf` read |
| Missing env vars | High | Cross-referenced `.env.example` vs Terraform env blocks |
| Port mismatch | High | `target_port = 8080` vs `EXPOSE 3000` in Dockerfile |
| frontdoor.tf missing | High | `ls infra/` — file not present |
| Private endpoint missing | High | No `azurerm_private_endpoint` resource in main.tf |
| Remote state status | High | Commented-out backend block confirmed |
| CI build matrix | Medium | Inferred from comment; full matrix YAML not fully quoted |
| Live Azure state | None | No credentials available |

---

## 10. Findings

### F-14-A — Container App `target_port = 8080` vs API `PORT = 3000` (SEVERITY: Critical)

- **File**: `infra/main.tf:268`, `Dockerfile:EXPOSE 3000`, `.env.example:9`
- **Impact**: Staging deployment unreachable — Container Apps routes to 8080, app listens on 3000.
- **Fix**: Change `target_port = 8080` to `target_port = 3000` in `main.tf:268`, or add `PORT=8080` to the Container App env block.

### F-14-B — Terraform injects only 4 of ~20 required env vars (SEVERITY: Critical)

- **File**: `infra/main.tf:237–253`
- **Impact**: Auth fails, LLM fails, Plaid/Base rail fails. A staged deployment with these 4 vars boots but is non-functional.
- **Fix**: Add Key Vault secrets for all env vars from `.env.example` and reference them in the Container App `env` + `secret` blocks. Group by rotation frequency: stable (JWT config, model names) vs rotatable (API keys, contract addresses).

### F-14-C — `frontdoor.tf` missing (SEVERITY: High)

- **File**: `infra/main.tf:300–302` (comment references `./frontdoor.tf`)
- **Impact**: Front Door profile exists but routes no traffic. `api.sandbox.brain.fi` is unconfigured.
- **Fix**: Create `infra/frontdoor.tf` with origin group, origin (Container App `api` FQDN), route (HTTPS → origin), WAF policy.

### F-14-D — Postgres private endpoint missing (SEVERITY: High)

- **File**: `infra/main.tf:86–88`
- **Impact**: `public_network_access_enabled = false` + no private endpoint = Container Apps cannot reach Postgres.
- **Fix**: Add `azurerm_private_endpoint` for the Postgres server within the Container Apps environment VNET. Requires VNET injection for the Container App environment.

### F-14-E — Terraform remote state commented out (SEVERITY: High)

- **File**: `infra/versions.tf:22–28`
- **Impact**: Local state — CI or second machine creates diverged state.
- **Fix**: Provision `brain-tfstate` resource group and `braintfstate` storage account (manually, once), then uncomment the backend block and run `terraform init -migrate-state`.

### F-14-F — `db-roles.sql` has no automated application path (SEVERITY: Medium)

- **File**: `infra/db-roles.sql`, `infra/main.tf` (no reference)
- **Impact**: Production database does not have `brain_app` / `brain_privileged` roles; RLS policies are armed but enforcement depends on the `brain_admin` owner role bypassing RLS.
- **Fix**: Add a `null_resource` with a `local-exec` provisioner, or a deploy pipeline step that runs `psql -v brain_app_password=... -f db-roles.sql` against the provisioned Postgres after Terraform apply.

---

## 11. Recommended Next Steps

| Priority | Action |
|----------|--------|
| P0 | Fix `target_port = 3000` in `main.tf` |
| P0 | Add all required env vars to Terraform Container App template (auth, API keys, contract addresses) |
| P0 | Add Postgres private endpoint + VNET injection for Container App environment |
| P1 | Create `infra/frontdoor.tf` with origin, route, and WAF policy |
| P1 | Uncomment remote backend, provision tfstate storage, migrate local state |
| P1 | Automate `db-roles.sql` application in the deploy pipeline |
| P2 | Narrow default `var.services` to `["api"]` (matching `poc.tfvars`), add separate `staging.tfvars` |
| P2 | Add `terraform plan` to `pr.yml` for infrastructure change visibility |
