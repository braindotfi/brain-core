# Brain infrastructure

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
