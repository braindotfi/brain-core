# R-03 Staging Deploy Runbook

Turnkey, ordered steps to light up the Azure staging deploy chain (risk **R-03**):
move from "demo-ready" to "staging-exercised" by making
`build → push → deploy → staging E2E` run continuously on merge to `main`.

This is the operator/infra companion to the engineering work already merged. It
does **not** require touching application code; it requires Azure provisioning,
secrets/vars, and a handful of **infra gaps to close first** (§2) that the
current Terraform/workflow scaffolding does not yet cover.

- Readiness signal for this work: `pnpm run production-readiness --profile staging`
  against the staging env should go GREEN (see `scripts/production-readiness.mjs`).
- Cross-references (do not duplicate): infra commands `infra/README.md`;
  rollback `docs/rollback.md`; mainnet money-path sequencing
  `docs/v0.4-go-live-runbook.md`; secrets policy Engineering Standards §10.
- **Mainnet is out of scope here** and stays blocked on R-01 (external contract
  audit). This runbook gets staging (Base Sepolia + Plaid sandbox) green.

---

## 1. Prerequisites

- Azure subscription + permission to create a resource group, Key Vault,
  Postgres Flexible Server, Redis, Storage, ACR, Container Apps, Front Door, and
  an Azure AD app registration (for GitHub OIDC).
- Terraform 1.9+, Azure CLI (`az`), `psql`, repo admin on GitHub (to set Actions
  secrets/variables and an `environment`).
- The single runtime image `brain-core` builds (root `Dockerfile`); it runs as
  api or worker by env (R-13: `BRAIN_HTTP_ENABLED` + `BRAIN_WORKERS`).

---

## 2. Infra gaps to close BEFORE first boot (important)

The committed `infra/main.tf` is POC-level and predates R-12/R-13. As written, a
deployed Container App **will fail its boot fences** until these are addressed.
Close each (in Terraform, the deploy step, or Key Vault) before flipping
`DEPLOY_ENABLED`:

1. **App must connect as `brain_app`, not the admin role.** `azurerm_key_vault_secret.database_url`
   builds the URL with `brain_admin` (the PG admin). Under that role RLS is not
   enforced (Standards §1.2). Point the app's `DATABASE_URL` at the `brain_app`
   role created by `infra/db-roles.sql` (§3.B).
2. **Wire the eight §4 least-privilege role URLs (R-12).** The api requires
   `BRAIN_WIKI_DB_URL` + the eight `BRAIN_*_DB_URL` (raw/canonical/ledger/
   execution/audit-verifier/audit-publisher/resolver/tenant-deletion) in
   `NODE_ENV=production`, fenced by `composition/db-isolation.ts` and asserted by
   the boot role check. The Container App `env`/`secret` blocks wire only
   `DATABASE_URL` + `REDIS_URL` today; add the rest as Key Vault-backed secrets.
   (An api-only process needs the wiki + resolver + tenant-deletion +
   audit-verifier URLs; a worker process needs its group's URLs. See R-12 in
   `docs/risk-register.md` for the per-pool map.)
3. **Decide the process topology (R-13).** Either run one all-in-one container
   (omit `BRAIN_HTTP_ENABLED`/`BRAIN_WORKERS`, defaults reproduce the historical
   single process) or split into an `api` Container App (`BRAIN_HTTP_ENABLED=true`,
   `BRAIN_WORKERS=none`) + a `worker` Container App (`BRAIN_HTTP_ENABLED=false`,
   `BRAIN_WORKERS=all`, no public ingress). The compose split in
   `docker-compose.prod.yml` is the reference; worker replicas are lease-safe
   (R-13 follow-up).
4. **Wire the remaining required app env as Key Vault secrets** (§3.C list):
   AUTH (JWKS/issuer/audience + `AUTH_SIGN_KEY`), `BASE_RPC_URL` (Sepolia),
   `BRAIN_SESSION_KEY`, `AUDIT_PUBLISHER_KEY` + `AUDIT_ANCHOR_ADDRESS`,
   `BRAIN_AGENTS_INBOUND_SECRET` (if agents), `BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_URL`,
   `OPENAI_API_KEY`, the S3/Storage blob settings, `BRAIN_BASE_CHAIN_ID=84532`.
5. **Ingress port** must match the app `PORT` (the app defaults to `PORT=3000`;
   `azurerm_container_app.service` sets `target_port = 8080`). Align them.
6. **Image model**: the deploy/promote jobs note "only api image built; expand as
   per-service Dockerfiles land." Confirm the build matrix pushes the image(s)
   the Container App(s) reference (`brain-<svc>:<sha>`).

> These are the difference between "infra exists" and "the app boots." Track them
> as infra PRs against `infra/main.tf` + the deploy job; none require app-code
> changes.

---

## 3. One-time provisioning (in order)

### A. Provision the Azure stack (Terraform)

```bash
cd infra
terraform init
terraform apply -var="environment=staging"
```

Creates: resource group, user-assigned managed identity, Key Vault (+ RBAC for
the identity), Postgres Flexible Server + `brain` DB + extensions, Redis,
Storage (raw-artifacts immutable container + audit-exports), ACR, Log Analytics,
Container App Environment + Container App(s), Front Door, and the
`database-url` / `redis-url` / `pg_admin` Key Vault secrets. Capture outputs:
ACR name + login server, Key Vault name, Postgres FQDN, managed-identity client id.

### B. Apply the DB role model + capture role passwords

Connect to the provisioned Postgres as the admin and apply the role model, then
store each role's password in Key Vault (the deploy/app reads them as the
`BRAIN_*_DB_URL` secrets):

```bash
# psql as the pg admin against the Flexible Server, substituting role passwords:
psql "host=<pg-fqdn> user=brain_admin dbname=brain sslmode=require" \
  -v brain_app_password="$(openssl rand -base64 24)" \
  -v brain_privileged_password="$(openssl rand -base64 24)" \
  -v brain_wiki_reader_password="$(openssl rand -base64 24)" \
  -v brain_raw_worker_password="$(openssl rand -base64 24)" \
  -v brain_canonical_projector_password="$(openssl rand -base64 24)" \
  -v brain_ledger_projector_password="$(openssl rand -base64 24)" \
  -v brain_execution_worker_password="$(openssl rand -base64 24)" \
  -v brain_audit_verifier_password="$(openssl rand -base64 24)" \
  -v brain_audit_publisher_password="$(openssl rand -base64 24)" \
  -v brain_resolver_password="$(openssl rand -base64 24)" \
  -v brain_tenant_deletion_password="$(openssl rand -base64 24)" \
  -f infra/db-roles.sql
```

Run the migrations first (`node tools/migrate/dist/cli.js up` against the admin
URL) so `db-roles.sql`'s grant loops see every table. Store each generated
password + the composed `BRAIN_*_DB_URL` (one per role, `…?sslmode=require`) as
Key Vault secrets.

### C. Populate the app's Key Vault secrets

Map the operator secrets from `.env.prod.example` into Key Vault (referenced by
the Container App `secret` blocks via managed identity). Minimum for a staging
boot: the eight §4 role URLs + `BRAIN_WIKI_DB_URL` (§3.B), `AUTH_JWKS_URL` /
`AUTH_ISSUER` / `AUTH_AUDIENCE` / `AUTH_SIGN_KEY`, `BASE_RPC_URL` (Sepolia),
`BRAIN_SESSION_KEY`, `AUDIT_PUBLISHER_KEY` + `AUDIT_ANCHOR_ADDRESS`,
`BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_URL`, `OPENAI_API_KEY`, the S3/blob settings,
`BRAIN_BASE_CHAIN_ID=84532`, and (if the Python agents run)
`BRAIN_AGENTS_INBOUND_SECRET`.

### D. Configure GitHub OIDC + Actions secrets/variables

1. Create an Azure AD app + **federated credential** trusting this GitHub repo
   (subject scoped to the `staging` environment / `main` branch); grant it
   Contributor on the RG + `AcrPush` on the ACR.
2. Set the repo **secrets**:

   | Secret                  | Source                                     |
   | ----------------------- | ------------------------------------------ |
   | `AZURE_CLIENT_ID`       | the AAD app (OIDC) client id               |
   | `AZURE_TENANT_ID`       | Azure tenant id                            |
   | `AZURE_SUBSCRIPTION_ID` | Azure subscription id                      |
   | `ACR_NAME`              | ACR name (from Terraform)                  |
   | `ACR_LOGIN_SERVER`      | ACR login server, e.g. `<name>.azurecr.io` |

3. Set the repo **variable** `DEPLOY_ENABLED = true` (gates the build/push/deploy/
   staging-E2E jobs in `.github/workflows/main.yml`).

---

## 4. First deploy

Merge to `main` (or re-run the `main` workflow). With `DEPLOY_ENABLED=true` the
chain runs: `build + push container images` → `deploy → staging` (revision per
service) → `E2E → staging` (`tests/e2e` against `https://api.sandbox.brain.fi/v1`,
or your staging host). Watch with `gh run watch` / the Actions UI; the deploy
jobs are no longer skipped.

---

## 5. Verify staging is green

- `pnpm run production-readiness --profile staging` sourced against the staging
  env → expect GREEN (DB isolation + rails + AES key + testnet executor row).
- The api boot log line `brain.runtime.capabilities` reports per-rail + per-fence
  - `wikiDbIsolation` / `privilegedDbIsolation` true.
- `GET /health` returns ok; one gated payment + one audit anchor succeed
  (golden-path / `docs/golden-path.md`).
- The five `main` E2E jobs (`E2E → staging`) are green for the deployed SHA.

## 6. Optional: light up the gated E2E jobs

Once staging has a deployed `BrainSmartAccount` + a gas-funded throwaway session
key on Base Sepolia, enable the dormant jobs:

- **Testnet on-chain executor E2E (R-14):** set `vars.TESTNET_ONCHAIN_E2E_ENABLED=true`
  - `secrets.BRAIN_TESTNET_RPC_URL` / `secrets.BRAIN_TESTNET_SESSION_KEY` +
    `vars.BRAIN_TESTNET_SMART_ACCOUNT` / `vars.BRAIN_TESTNET_TARGET` (see
    `tests/e2e/README.md`). The success case additionally needs a granted key +
    `vars.BRAIN_TESTNET_SUCCESS_ENABLED`.
- **External-agent MCP E2E:** `vars.E2E_EXTERNAL_AGENT_ENABLED=true` +
  `secrets.BRAIN_EXTERNAL_AGENT_TOKEN` + the throwaway tenant source/vendor vars.

## 7. Rollback / mainnet

- **Rollback** a bad staging revision: `docs/rollback.md` (Azure Container Apps
  revision weights).
- **Mainnet promotion** is a separate path, gated on the external contract audit
  (R-01) and the mainnet escrow boot fence; sequencing in
  `docs/v0.4-go-live-runbook.md`. Do not enable mainnet rails from this runbook.

---

## Appendix: GitHub secrets/vars referenced by the deploy + gated jobs

| Name                                                                        | Kind       | Used by                                          |
| --------------------------------------------------------------------------- | ---------- | ------------------------------------------------ |
| `DEPLOY_ENABLED`                                                            | var        | gates build/push/deploy/staging-E2E (`main.yml`) |
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID`             | secret     | `azure/login` OIDC                               |
| `ACR_NAME` / `ACR_LOGIN_SERVER`                                             | secret     | ACR login + image push (staging)                 |
| `ACR_LOGIN_SERVER_PROD`                                                     | secret     | production promote step (mainnet path)           |
| `TESTNET_ONCHAIN_E2E_ENABLED` + `BRAIN_TESTNET_*`                           | var/secret | testnet executor E2E (R-14)                      |
| `E2E_EXTERNAL_AGENT_ENABLED` + `BRAIN_EXTERNAL_AGENT_TOKEN` + source/vendor | var/secret | external-agent MCP E2E                           |
