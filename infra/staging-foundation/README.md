# Azure staging rehearsal foundation

This root creates the destroyable prerequisites consumed as data sources by
`infra/staging-migration`:

- `brain-core-staging-vnet`, `snet-apps`, and `snet-private-endpoints`
- `brain-core-staging-kv` with RBAC, purge protection, public access disabled, a
  private endpoint, and private DNS
- `brain-core-staging-env` and its directly required Log Analytics workspace
- `braincorestagingacr` with admin credentials disabled

The empty `brain-core-staging-api-rg`, staging state backend, and GitHub OIDC principal
are created by `infra/bootstrap-staging`. They remain after teardown so a later
rehearsal can recreate the foundation without subscription-wide GitHub rights.
An empty resource group and workload identity have no usage charge. The state
account is the only retained billable storage resource and should remain tiny.

All billable resources in this root are tagged `lifecycle=ephemeral` and carry
an owner, expiry, and GitHub run ID. The separate teardown workflow plans and
applies destruction of this root only. It cannot destroy bootstrap state,
production resources, or the staging workload resource group.

## First bootstrap

An approved Azure and Entra operator must plan and apply
`infra/bootstrap-staging` first. Review its local state location before apply.
It requires privileges to create resource groups, role assignments, application
registrations, and the staging state account. No recurring GitHub principal is
granted subscription scope.

Configure the protected GitHub environment `azure-staging-rehearsal` with the
non-secret outputs from the bootstrap root and these additional variables:

- `AZURE_STAGING_MIGRATION_OPERATOR_OBJECT_ID`
- `AZURE_STAGING_INDEPENDENT_VERIFIER_OBJECT_ID`
- `AZURE_STAGING_REHEARSAL_OWNER`

The migration operator and verifier must be different principals. GitHub OIDC
has no Key Vault data-plane role. The operator can write evidence secrets and
the verifier can read them.

## Plan and apply

Dispatch `deploy-azure-staging-foundation.yml` with `action=plan`. The workflow
prints the complete plan and retains the exact binary plan for two days. After
review, dispatch `action=apply` with the plan run ID and exact confirmation. The
apply consumes that reviewed plan and refuses to create a new one.

The plan must contain no replacement, destroy, production name, production
resource ID, or resource outside `brain-core-staging-api-rg`. The first live plan also
confirms whether the globally scoped Key Vault and ACR names are available and
whether `10.30.0.0/16` is non-overlapping.

No Terraform apply is authorized merely by merging this code.

After this foundation exists, `infra/staging-migration` can resolve its Azure
data sources. That root also creates a Key Vault key through the vault data
plane. Because this vault is private, its plan and apply must run from a
separately reviewed in-VNet Terraform runner. A GitHub-hosted runner cannot
reach it, and this foundation does not weaken the firewall or introduce a
client secret to work around that boundary. Provisioning and rehearsing that
private runner remains a separate execution gate before Task 2 can start.

## Teardown

Remove the `infra/staging-migration` and other ephemeral rehearsal roots first.
Then use the separately protected teardown workflow. Key Vault purge protection
keeps the deleted vault recoverable, and the provider recovers it on a later
rehearsal. The state account, OIDC principal, and empty workload resource group
remain outside this root.
