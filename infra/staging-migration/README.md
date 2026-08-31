# Staging migration intake

This Terraform root implements the encrypted intake approved for VM migration
rehearsals. It creates staging resources only. It does not copy data, create a
per-run container, issue a SAS, connect networks, or apply itself.

## Prerequisites

The persistent and ephemeral resources scoped by PR #745 must already exist:

- staging resource group, VNet, private-endpoint subnet, and Container Apps
  environment
- staging ACR containing the reviewed SHA-tagged API image
- persistent staging Key Vault
- separate staging Terraform backend

The source-to-staging route is owned by `infra/staging-migration-route`. It has
a separate state and operator because the recurring staging deploy identity
must not receive rights on the authoritative VM VNet.

## Resources

This root creates:

- an ephemeral Blob account used only for encrypted migration intake
- disabled public network access, disabled Shared Key, HTTPS-only traffic, and
  a Blob private endpoint
- a lifecycle rule and soft-delete window capped at seven days
- a bootstrap RSA-3072 Key Vault version with only `wrapKey` and `unwrapKey`
- separate prepare and validation identities and Container App Jobs
- a direct create-and-write role for an approved VM managed identity
- a create-and-write user-delegation SAS issuer role when Task 1 proves no
  usable VM managed identity exists

The bootstrap key version exists only to establish key-scoped RBAC. The prepare
job calls Key Vault Create Key with the same name for every approved run. Key
Vault then creates a new version. The job returns only the versioned key ID,
SHA-256 SPKI fingerprint, and public key.

The storage account contains no Terraform-managed data containers. The prepare
job creates exactly one `intake-<run-id>` container after proving it does not
already exist.

## Source authentication decision

Run `scripts/ops/inventory-azure-vm-managed-identity.sh` during Task 1. It
records whether the correct VM has a system-assigned or user-assigned identity.
Finding an identity makes it a candidate, not a completed decision.

Use `source_upload_auth_mode = "managed_identity"` only after the selected
identity can obtain an Azure Storage token and the disposable encrypted canary
succeeds with the direct create-and-write role. Otherwise use
`source_upload_auth_mode = "user_delegation_sas"` and the approved Sanket Entra
principal. The fallback role can issue a user-delegation SAS and create or
write blobs, but cannot read, list, or delete them.

Do not use a storage account key, service SAS, account SAS, connection string,
or public firewall exception.

For a user-assigned VM identity, pass the Task 1 client ID as
`MIGRATION_MANAGED_IDENTITY_CLIENT_ID` to the source helper. Leave it unset only
for the confirmed system-assigned identity.

## Plan inputs

No values in this example are credentials:

```bash
terraform init -reconfigure -backend-config=../backend-staging-migration.hcl
terraform plan \
  -var='staging_subscription_id=<staging-subscription-uuid>' \
  -var='migration_storage_account_name=braincorestgmig<unique>' \
  -var='source_upload_auth_mode=managed_identity' \
  -var='source_uploader_principal_id=<task-1-principal-uuid>' \
  -var='api_image=braincorestagingacr.azurecr.io/brain-api:<short-sha>' \
  -var='rehearsal_owner=<name>' \
  -var='rehearsal_expires_at=<rfc3339>' \
  -var='github_run_id=<digits>'
```

The SAS fallback replaces `source_uploader_principal_id` with
`sas_issuer_principal_id`. The protected plan must show no production resource
ID and no role assignment outside the dedicated migration account, staging
Key Vault key, staging ACR, and staging identities.

## Required run sequence

1. Complete Task 1 identity and DNS inventory.
2. Apply this root and the separately approved temporary route.
3. Dispatch `ops-staging-migration-intake` with action `prepare`.
4. Save the complete public-key receipt in a mode-`0600` run directory. The
   source helper requires and rechecks its versioned key ID, RSA-3072 size, and
   SHA-256 SPKI fingerprint.
5. If needed, have Sanket sign in through the run directory's isolated Azure
   CLI profile and issue a user-delegation SAS directly to that directory. Its
   expiry is the measured transfer duration plus a 25 percent or one-hour
   safety margin, whichever is larger. The script fails above 12 hours and
   never prints the SAS.
6. Use `staging-migration-upload.sh canary` from the source VM.
7. Dispatch `validate-canary` with the receipt's key ID and plaintext hash.
8. Require the in-VNet job to unwrap, decrypt, verify, and delete both canary
   objects successfully.
9. Only then authorize real encrypted rehearsal extraction.

Any public Blob resolution, fingerprint mismatch, failed unwrap, failed hash,
or canary cleanup failure blocks real data movement.

## Cleanup

After restore and independent evidence acceptance:

1. Delete source plaintext under the approved VM secure-deletion procedure.
2. Confirm no dependent ciphertext is required for rollback or evidence.
3. Dispatch `cleanup` with `DELETE-<run-id>`.
4. The prepare identity deletes the complete per-run container, confirms it no
   longer resolves, and only then disables that exact Key Vault version.
5. Remove temporary uploader roles and the source VNet route through their
   reviewed Terraform states.
6. Tear down the ephemeral migration storage account with the rehearsal stack.

Blob soft delete can retain recoverable encrypted bytes for at most seven days.
The disabled Key Vault version remains recoverable if an approved rollback must
temporarily re-enable it.
