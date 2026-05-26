# Brain Infrastructure

Terraform configuration for Brain's Azure stack. Full resources land in stage-8.

See `Brain_MVP_Architecture.md` §2 for the stack choices and
`Brain_Engineering_Standards.md` §10 for deployment + secrets policy.

## Environments

| Environment | Region         | Purpose                               |
| ----------- | -------------- | ------------------------------------- |
| staging     | eastus         | Plaid sandbox, Base Sepolia           |
| production  | eastus + westus3 | Plaid prod, Base mainnet (post-audit) |

## Secrets

Never in git. Everything reads from Azure Key Vault via managed identity.
Rotation schedule documented in `infra/secrets.md` (to land in stage-8).

## Commands

```bash
cd infra
terraform init
terraform validate
terraform plan  -var="environment=staging"
terraform apply -var="environment=staging"
```

Production plans require a manual approval step in the GitHub Actions
workflow (see `.github/workflows/main.yml`, stage-8).

## pgBouncer rollout plan (P2.3)

`DATABASE_POOL_MAX=10` per app instance does not scale: as instances multiply,
total Postgres connections = instances × pool, and managed Postgres has a hard
`max_connections`. pgBouncer multiplexes many client connections onto few server
connections.

**When to deploy:** before horizontal scale-out — when
`instances × DATABASE_POOL_MAX` approaches ~60–70% of the Postgres
`max_connections`, or connection-establishment latency/`too many connections`
errors appear. TODO(brain-hardening): set the exact instance-count trigger from
the chosen Postgres tier's `max_connections`.

**Transaction vs session mode:**

- **Transaction mode** (preferred): a server connection is returned to the pool
  at the end of each transaction → highest multiplexing. Constraint: **no
  session-scoped state across transactions**. Brain's `withTenantScope` uses
  `SET LOCAL app.tenant_id` inside the transaction (transaction-scoped), so RLS
  is compatible. **Prepared statements** must be handled carefully — pg's named
  prepared statements are session-scoped; use `pg` with prepared statements
  disabled or pgBouncer ≥1.21 protocol-level prepared-statement support.
  TODO(brain-hardening): confirm the `pg` client isn't relying on session-pinned
  prepared statements, and that no long-lived transactions (the outbox worker
  uses short `FOR UPDATE SKIP LOCKED` txns — compatible).
- **Session mode:** a server connection is pinned for the whole client session —
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

Plan only — no implementation in this pass.
