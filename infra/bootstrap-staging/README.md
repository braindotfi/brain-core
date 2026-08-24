# Azure staging bootstrap

This root creates the low-cost resources that must survive rehearsal teardown:

- the staging Terraform state resource group, account, and container
- the empty `brain-staging-rg` authorization boundary
- the staging-only GitHub OIDC application, service principal, and federated
  credential
- resource-group-scoped deployment roles and state-blob access

It uses local Terraform state because it creates the remote backend. Run it
only from an approved encrypted operator workstation. Never commit its state.
The authenticated operator needs Azure rights to create resource groups, role
assignments, and application registrations. The operator also needs a
`GITHUB_TOKEN` with repository administration plus Actions secrets and
variables write access. This is a one-time bootstrap, not a GitHub workflow.

The recurring GitHub principal has no subscription-wide write role. It has
Contributor and Role Based Access Control Administrator only on
`brain-staging-rg`, plus Storage Blob Data Contributor only on the staging state
account. It also has Reader on the dedicated staging subscription so workflow
preflight can prove there are no production resources or overlapping networks.
It has no write role at subscription scope, no production role, and no client
secret.

Plan from an encrypted operator directory after copying and completing
`terraform.tfvars.example` outside the repository:

```bash
terraform init
terraform plan -input=false -no-color \
  -var-file=<approved-bootstrap-tfvars> \
  -out=<approved-bootstrap-plan-path>
terraform show -no-color <approved-bootstrap-plan-path>
```

Do not apply until that bootstrap plan receives separate approval. The plan is
expected to contain 22 creates, zero changes, and zero destroys on a new
subscription. A different count requires review.

The bootstrap creates the protected `azure-staging-rehearsal` GitHub
environment, required reviewers, protected-branch policy, secrets, and
variables. No manual copy step or client secret is used.

The bootstrap creates these environment secrets from non-secret identifiers:

- `AZURE_STAGING_CLIENT_ID`
- `AZURE_STAGING_TENANT_ID`
- `AZURE_STAGING_SUBSCRIPTION_ID`

It also creates these environment variables:

- `AZURE_STAGING_EXPECTED_SUBSCRIPTION_ID`
- `AZURE_PRODUCTION_SUBSCRIPTION_ID_DENY`
- `AZURE_STAGING_RESOURCE_GROUP=brain-staging-rg`
- `AZURE_STAGING_STATE_ACCOUNT=brainfitfstatestg`
- `AZURE_STAGING_MIGRATION_OPERATOR_OBJECT_ID`
- `AZURE_STAGING_INDEPENDENT_VERIFIER_OBJECT_ID`
- `AZURE_STAGING_REHEARSAL_OWNER`

The workload resource group and state account are protected from destroy. They
have no compute cost. Rehearsal resources belong to `infra/staging-foundation`
and can be destroyed independently.
