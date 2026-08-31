locals {
  name_prefix = "brain-core-staging-migration"
  tags = {
    service     = "brain"
    environment = "staging"
    purpose     = "migration-rehearsal"
    managed_by  = "terraform"
    owner       = var.rehearsal_owner
    expires_at  = var.rehearsal_expires_at
    github_run  = var.github_run_id
  }
}

data "azurerm_resource_group" "staging" {
  name = var.staging_resource_group_name
}

data "azurerm_key_vault" "staging" {
  name                = var.staging_key_vault_name
  resource_group_name = data.azurerm_resource_group.staging.name
}

data "azurerm_virtual_network" "staging" {
  name                = var.staging_vnet_name
  resource_group_name = data.azurerm_resource_group.staging.name
}

data "azurerm_subnet" "private_endpoints" {
  name                 = var.staging_private_endpoint_subnet_name
  virtual_network_name = data.azurerm_virtual_network.staging.name
  resource_group_name  = data.azurerm_resource_group.staging.name
}

data "azurerm_container_app_environment" "staging" {
  name                = var.staging_container_app_environment_name
  resource_group_name = data.azurerm_resource_group.staging.name
}

data "azurerm_container_registry" "staging" {
  name                = var.staging_acr_name
  resource_group_name = data.azurerm_resource_group.staging.name
}

resource "azurerm_user_assigned_identity" "prepare" {
  name                = "${local.name_prefix}-prepare"
  resource_group_name = data.azurerm_resource_group.staging.name
  location            = data.azurerm_resource_group.staging.location
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "validate" {
  name                = "${local.name_prefix}-validate"
  resource_group_name = data.azurerm_resource_group.staging.name
  location            = data.azurerm_resource_group.staging.location
  tags                = local.tags
}

# This Terraform-owned version is a bootstrap anchor for key-scoped RBAC. It is
# never handed to the source operator. The prepare job creates a new version of
# this key for every rehearsal and reports that exact version ID and fingerprint.
resource "azurerm_key_vault_key" "migration_wrap" {
  name         = "migration-rehearsal-wrap"
  key_vault_id = data.azurerm_key_vault.staging.id
  key_type     = "RSA"
  key_size     = 3072
  key_opts     = ["wrapKey", "unwrapKey"]

  tags = merge(local.tags, { use = "bootstrap-version-not-for-data" })
}

resource "azurerm_role_assignment" "prepare_key" {
  scope                = azurerm_key_vault_key.migration_wrap.resource_versionless_id
  role_definition_name = "Key Vault Crypto Officer"
  principal_id         = azurerm_user_assigned_identity.prepare.principal_id
}

resource "azurerm_role_assignment" "validate_key" {
  scope                = azurerm_key_vault_key.migration_wrap.resource_versionless_id
  role_definition_name = "Key Vault Crypto Service Encryption User"
  principal_id         = azurerm_user_assigned_identity.validate.principal_id
}

resource "azurerm_storage_account" "migration" {
  name                             = var.migration_storage_account_name
  resource_group_name              = data.azurerm_resource_group.staging.name
  location                         = data.azurerm_resource_group.staging.location
  account_tier                     = "Standard"
  account_replication_type         = "ZRS"
  account_kind                     = "StorageV2"
  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  public_network_access_enabled    = false
  shared_access_key_enabled        = false
  allow_nested_items_to_be_public  = false
  cross_tenant_replication_enabled = false
  local_user_enabled               = false
  sftp_enabled                     = false
  tags                             = local.tags

  blob_properties {
    versioning_enabled  = false
    change_feed_enabled = false

    delete_retention_policy {
      days = var.migration_retention_days
    }

    container_delete_retention_policy {
      days = var.migration_retention_days
    }
  }

  network_rules {
    default_action = "Deny"
    bypass         = ["None"]
  }
}

resource "azurerm_storage_management_policy" "migration" {
  storage_account_id = azurerm_storage_account.migration.id

  rule {
    name    = "expire-migration-ciphertext"
    enabled = true

    filters {
      blob_types = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = var.migration_retention_days
      }
    }
  }
}

resource "azurerm_private_dns_zone" "blob" {
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = data.azurerm_resource_group.staging.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "staging_blob" {
  name                  = "${local.name_prefix}-blob-link"
  resource_group_name   = data.azurerm_resource_group.staging.name
  private_dns_zone_name = azurerm_private_dns_zone.blob.name
  virtual_network_id    = data.azurerm_virtual_network.staging.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "migration_blob" {
  name                = "${local.name_prefix}-blob-pe"
  resource_group_name = data.azurerm_resource_group.staging.name
  location            = data.azurerm_resource_group.staging.location
  subnet_id           = data.azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "${local.name_prefix}-blob-psc"
    private_connection_resource_id = azurerm_storage_account.migration.id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob.id]
  }
}

resource "azurerm_role_definition" "direct_uploader" {
  name        = "${local.name_prefix}-direct-uploader"
  scope       = azurerm_storage_account.migration.id
  description = "Create and write staging migration blobs without read, list, or delete."

  permissions {
    actions = [
      "Microsoft.Storage/storageAccounts/read",
    ]
    data_actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
    ]
  }

  assignable_scopes = [azurerm_storage_account.migration.id]
}

resource "azurerm_role_definition" "sas_issuer" {
  name        = "${local.name_prefix}-sas-issuer"
  scope       = azurerm_storage_account.migration.id
  description = "Issue create-and-write user delegation SAS for staging migration intake."

  permissions {
    actions = [
      "Microsoft.Storage/storageAccounts/read",
      "Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action",
    ]
    data_actions = [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
    ]
  }

  assignable_scopes = [azurerm_storage_account.migration.id]
}

resource "azurerm_role_assignment" "source_uploader" {
  count              = var.source_upload_auth_mode == "managed_identity" ? 1 : 0
  scope              = azurerm_storage_account.migration.id
  role_definition_id = azurerm_role_definition.direct_uploader.role_definition_resource_id
  principal_id       = var.source_uploader_principal_id
}

resource "azurerm_role_assignment" "sas_issuer" {
  count              = var.source_upload_auth_mode == "user_delegation_sas" ? 1 : 0
  scope              = azurerm_storage_account.migration.id
  role_definition_id = azurerm_role_definition.sas_issuer.role_definition_resource_id
  principal_id       = var.sas_issuer_principal_id
}

resource "azurerm_role_assignment" "prepare_blob" {
  scope                = azurerm_storage_account.migration.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = azurerm_user_assigned_identity.prepare.principal_id
}

resource "azurerm_role_assignment" "validate_blob" {
  scope                = azurerm_storage_account.migration.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.validate.principal_id
}

resource "azurerm_role_assignment" "prepare_acr" {
  scope                = data.azurerm_container_registry.staging.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.prepare.principal_id
}

resource "azurerm_role_assignment" "validate_acr" {
  scope                = data.azurerm_container_registry.staging.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.validate.principal_id
}

locals {
  job_environment = {
    BRAIN_STAGING_MIGRATION_RUN_ID                   = "template-only"
    BRAIN_STAGING_MIGRATION_STORAGE_ACCOUNT          = azurerm_storage_account.migration.name
    BRAIN_STAGING_MIGRATION_STORAGE_RESOURCE_ID      = azurerm_storage_account.migration.id
    BRAIN_STAGING_MIGRATION_EXPECTED_SUBSCRIPTION_ID = var.staging_subscription_id
    BRAIN_STAGING_MIGRATION_KEY_VAULT_URI            = data.azurerm_key_vault.staging.vault_uri
    BRAIN_STAGING_MIGRATION_KEY_NAME                 = azurerm_key_vault_key.migration_wrap.name
  }
}

resource "azurerm_container_app_job" "prepare" {
  name                         = "${local.name_prefix}-prepare"
  resource_group_name          = data.azurerm_resource_group.staging.name
  location                     = data.azurerm_resource_group.staging.location
  container_app_environment_id = data.azurerm_container_app_environment.staging.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 900
  replica_retry_limit          = 0
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.prepare.id]
  }

  registry {
    server   = data.azurerm_container_registry.staging.login_server
    identity = azurerm_user_assigned_identity.prepare.id
  }

  template {
    container {
      name    = "prepare"
      image   = var.api_image
      cpu     = 0.5
      memory  = "1.0Gi"
      command = ["node", "scripts/ops/staging-migration-intake.mjs"]

      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.prepare.client_id
      }
      env {
        name  = "BRAIN_STAGING_MIGRATION_MODE"
        value = "prepare"
      }
      dynamic "env" {
        for_each = local.job_environment
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [
    azurerm_private_endpoint.migration_blob,
    azurerm_role_assignment.prepare_blob,
    azurerm_role_assignment.prepare_key,
  ]
}

resource "azurerm_container_app_job" "validate" {
  name                         = "${local.name_prefix}-validate"
  resource_group_name          = data.azurerm_resource_group.staging.name
  location                     = data.azurerm_resource_group.staging.location
  container_app_environment_id = data.azurerm_container_app_environment.staging.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 900
  replica_retry_limit          = 0
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.validate.id]
  }

  registry {
    server   = data.azurerm_container_registry.staging.login_server
    identity = azurerm_user_assigned_identity.validate.id
  }

  template {
    container {
      name    = "validate"
      image   = var.api_image
      cpu     = 0.5
      memory  = "1.0Gi"
      command = ["node", "scripts/ops/staging-migration-intake.mjs"]

      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.validate.client_id
      }
      env {
        name  = "BRAIN_STAGING_MIGRATION_MODE"
        value = "validate-canary"
      }
      dynamic "env" {
        for_each = local.job_environment
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name  = "BRAIN_STAGING_MIGRATION_KEY_ID"
        value = "template-only"
      }
      env {
        name  = "BRAIN_STAGING_MIGRATION_CANARY_SHA256"
        value = "template-only"
      }
    }
  }

  depends_on = [
    azurerm_private_endpoint.migration_blob,
    azurerm_role_assignment.validate_blob,
    azurerm_role_assignment.validate_key,
  ]
}
