# Brain Infrastructure

Terraform configuration for Brain's Azure stack.

See `Brain_MVP_Architecture.md` §2 for the stack choices,
`Brain_Engineering_Standards.md` §10 for deployment + secrets policy, and
`docs/diligence/diagrams/production-cutover-topology.mmd` for the topology.

## Layout

| File | Purpose |
| ---- | ------- |
| `main.tf` | Resource group, identity, Key Vault, Postgres, Redis, Storage, ACR, Container Apps + Jobs |
| `network.tf` | VNet, subnets, private DNS, Redis private endpoint |
| `secrets.tf` | Key Vault secret surface (role passwords, role URLs, app secrets) |
| `frontdoor.tf` | Front Door profile/endpoint/origin/route — gated on `enable_frontdoor` |
| `variables.tf` | Sizing and configuration knobs |
| `production.tfvars` | Production values (no secrets) |
| `backend-production.hcl` | Remote-state backend config |
| `bootstrap/` | One-time: creates the storage account holding remote state |
| `db-roles.sql` | Least-privilege roles + FORCE RLS sweep |
| `db-roles.Dockerfile` + `db-roles-entrypoint.sh` | Image for the db-roles job |

## Environments

| Environment | Region  | Purpose                                |
| ----------- | ------- | -------------------------------------- |
| staging     | canadacentral | Plaid sandbox, Base Sepolia      |
| production  | canadacentral | Plaid prod, Base Sepolia (mainnet post-audit, ADR-0007) |


> **Not eastus.** Postgres Flexible Server provisioning is restricted for this
> subscription in eastus — `az postgres flexible-server list-skus -l eastus` returns
> zero supported server editions with *"Provisioning is restricted in this region"*.
> canadacentral was chosen over centralindia because it supports zone-redundant HA.

## Secrets

Never in git. Everything reads from Azure Key Vault via managed identity.

`secrets.tf` provisions the full surface:

- **16 Postgres role passwords** (`db-password-*`) consumed by `db-roles.sql`
- **15 role connection URLs** (`database-url`, `brain-*-db-url`) consumed by the app
- **Generated app secrets** — `auth-cookie-secret`, `brain-agents-inbound-secret`,
  `brain-api-key-pepper`, `brain-demo-provision-secret`, `brain-service-token-secret`
- **Storage key** — `azure-blob-account-key`

### Operator-supplied secrets

These are created as **placeholders** and must be set out of band. Terraform
ignores changes to their values, so it will never revert them.

| Secret | Why it is not generated |
| ------ | ----------------------- |
| `auth-sign-key` | Structured JWK; regenerating invalidates every issued token |
| `audit-publisher-key` | EVM private key controlling real funds |
| `brain-session-key` | EVM private key controlling real funds |
| `openai-api-key` | External credential |
| `brain-api-token` | Minted by `tools/dev-token` against `auth-sign-key` |

```bash
az keyvault secret set --vault-name brain-production-kv \
  --name auth-sign-key --file ./auth-sign-key.json
```

> ⚠️ Leaving `audit-publisher-key` as a placeholder keeps the anchor publisher
> inert. That is the safe default while the legacy VM is still anchoring — two
> publishers on one `BrainAuditAnchor` race and burn gas on
> `RootAlreadyPublished`. Set it only after the VM worker is stopped.

## Commands

One-time, to create the remote-state storage account:

```bash
cd infra/bootstrap
terraform init && terraform apply
```

Then the main stack:

```bash
cd infra
terraform init -backend-config=backend-production.hcl
terraform plan  -var-file=production.tfvars -var="operator_ip=$(curl -s ifconfig.me)/32"
terraform apply -var-file=production.tfvars -var="operator_ip=$(curl -s ifconfig.me)/32"
```

`operator_ip` is required: the Key Vault is deny-by-default and Terraform writes
secrets over its data plane. Remove the exception once CI owns rotation.

No local Terraform install is needed — run it in Docker:

```bash
docker run --rm -v "$PWD:/infra" -w /infra hashicorp/terraform:1.13 validate
```

Production applies require a manual approval step in the GitHub Actions
workflow (see `.github/workflows/main.yml`).

## Post-apply order (load-bearing)

```bash
az containerapp job start -n brain-production-migrate  -g brain-production-rg
# wait for completion, THEN
az containerapp job start -n brain-production-db-roles -g brain-production-rg
```

**`migrate` must run before `db-roles`.** `db-roles.sql` grants by looping over
tables that already exist; running it first silently leaves the canonical and
ledger projector roles without grants, which surfaces in production as
`42501: permission denied` every ~10 seconds rather than as a failed job.

## pgBouncer rollout plan (P2.3)

`DATABASE_POOL_MAX=10` per app instance does not scale: as instances multiply,
total Postgres connections = instances × pool, and managed Postgres has a hard
`max_connections`. pgBouncer multiplexes many client connections onto few server
connections.

**When to deploy:** before horizontal scale-out. When
`instances × DATABASE_POOL_MAX` approaches ~60–70% of the Postgres
`max_connections`, or connection-establishment latency/`too many connections`
errors appear. TODO(brain-hardening): set the exact instance-count trigger from
the chosen Postgres tier's `max_connections`.

**Transaction vs session mode:**

- **Transaction mode** (preferred): a server connection is returned to the pool
  at the end of each transaction → highest multiplexing. Constraint: **no
  session-scoped state across transactions**. Brain's `withTenantScope` uses
  `SET LOCAL app.tenant_id` inside the transaction (transaction-scoped), so RLS
  is compatible. **Prepared statements** must be handled carefully. Pg's named
  prepared statements are session-scoped; use `pg` with prepared statements
  disabled or pgBouncer ≥1.21 protocol-level prepared-statement support.
  TODO(brain-hardening): confirm the `pg` client isn't relying on session-pinned
  prepared statements, and that no long-lived transactions (the outbox worker
  uses short `FOR UPDATE SKIP LOCKED` txns. Compatible).
- **Session mode:** a server connection is pinned for the whole client session.
  safe for any session state, but barely better than direct pooling. Use only if
  a transaction-mode incompatibility is found.

**Sizing:** `default_pool_size` per (user, db) ≈ a small multiple of Postgres
cores (e.g. 2× vCPU), `max_client_conn` set well above the sum of app pools.
Privileged (BYPASSRLS) connections (normalize worker, webhook resolver, audit
emitter, outbox worker) get a separate pgBouncer user/pool so request-path
saturation can't starve them.

**Terraform:** add a pgBouncer module (Azure Container App or sidecar) in front
of the Flexible Server; app `DATABASE_URL` points at pgBouncer, not Postgres
directly. TODO(brain-hardening): author `infra/modules/pgbouncer/`.

Plan only. No implementation in this pass.
