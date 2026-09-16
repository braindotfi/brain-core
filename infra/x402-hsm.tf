# RFC 0012 Phase 2 custody foundation. The first apply creates an inactive,
# private Managed HSM, its immutable security-domain store, and a separate
# backup-compatible store. Activation uses an effective two-of-two recovery
# model inside Azure's required three-certificate, quorum-two envelope. During
# the witnessed ceremony, x402_hsm_activated becomes true only after Azure
# confirms activation, enabling the key and backup role needed for the drill.

resource "azurerm_user_assigned_identity" "x402_treasury_signer" {
  count               = var.enable_x402_phase2_custody ? 1 : 0
  name                = "brain-x402-treasury-signer"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  tags                = merge(local.tags, { component = "x402-treasury" })
}

resource "azurerm_user_assigned_identity" "x402_hsm_backup" {
  count               = var.enable_x402_phase2_custody ? 1 : 0
  name                = "brain-x402-hsm-backup"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  tags                = merge(local.tags, { component = "x402-hsm-backup" })
}

resource "azurerm_key_vault_managed_hardware_security_module" "x402" {
  count                         = var.enable_x402_phase2_custody ? 1 : 0
  name                          = "brain-${var.environment}-x402-hsm"
  resource_group_name           = azurerm_resource_group.primary.name
  location                      = azurerm_resource_group.primary.location
  sku_name                      = "Standard_B1"
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  admin_object_ids              = [data.azurerm_client_config.current.object_id]
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = false
  tags                          = merge(local.tags, { component = "x402-treasury" })

  network_acls {
    bypass         = "None"
    default_action = "Deny"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_private_dns_zone" "x402_hsm" {
  count               = var.enable_x402_phase2_custody ? 1 : 0
  name                = "privatelink.managedhsm.azure.net"
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "x402_hsm" {
  count                 = var.enable_x402_phase2_custody ? 1 : 0
  name                  = "${local.name_prefix}-x402-hsm-link"
  resource_group_name   = azurerm_resource_group.primary.name
  private_dns_zone_name = azurerm_private_dns_zone.x402_hsm[0].name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "x402_hsm" {
  count               = var.enable_x402_phase2_custody ? 1 : 0
  name                = "${local.name_prefix}-x402-hsm-pe"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "${local.name_prefix}-x402-hsm-psc"
    private_connection_resource_id = azurerm_key_vault_managed_hardware_security_module.x402[0].id
    subresource_names              = ["managedhsm"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "x402-managed-hsm"
    private_dns_zone_ids = [azurerm_private_dns_zone.x402_hsm[0].id]
  }
}

resource "azurerm_storage_account" "x402_hsm_recovery" {
  count                             = var.enable_x402_phase2_custody ? 1 : 0
  name                              = "brainx402recoveryprod"
  resource_group_name               = azurerm_resource_group.primary.name
  location                          = azurerm_resource_group.primary.location
  account_tier                      = "Standard"
  account_replication_type          = "GRS"
  min_tls_version                   = "TLS1_2"
  shared_access_key_enabled         = false
  allow_nested_items_to_be_public   = false
  infrastructure_encryption_enabled = true
  public_network_access_enabled     = false
  tags                              = merge(local.tags, { component = "x402-recovery" })

  blob_properties {
    versioning_enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "x402_hsm_recovery" {
  count                 = var.enable_x402_phase2_custody ? 1 : 0
  name                  = "managed-hsm-security-domain"
  storage_account_id    = azurerm_storage_account.x402_hsm_recovery[0].id
  container_access_type = "private"
}

resource "azurerm_storage_container_immutability_policy" "x402_hsm_recovery" {
  count                                 = var.enable_x402_phase2_custody ? 1 : 0
  storage_container_resource_manager_id = azurerm_storage_container.x402_hsm_recovery[0].id
  immutability_period_in_days           = 2555
  protected_append_writes_enabled       = false
  protected_append_writes_all_enabled   = false
}

# Azure Managed HSM full backup rejects immutable-policy storage. This account
# is deliberately separate from x402_hsm_recovery and grants no shared-key or
# public-network path. Azure's trusted-service bypass is required for the HSM
# service to reach the account with its user-assigned managed identity.
resource "azurerm_storage_account" "x402_hsm_backup" {
  count                             = var.enable_x402_phase2_custody ? 1 : 0
  name                              = "brainx402backupprod"
  resource_group_name               = azurerm_resource_group.primary.name
  location                          = azurerm_resource_group.primary.location
  account_tier                      = "Standard"
  account_replication_type          = "GRS"
  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  shared_access_key_enabled         = false
  allow_nested_items_to_be_public   = false
  cross_tenant_replication_enabled  = false
  infrastructure_encryption_enabled = true
  public_network_access_enabled     = false
  tags                              = merge(local.tags, { component = "x402-hsm-backup" })

  blob_properties {
    versioning_enabled = true
  }

  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "x402_hsm_backup" {
  count                 = var.enable_x402_phase2_custody ? 1 : 0
  name                  = "managed-hsm-full-backups"
  storage_account_id    = azurerm_storage_account.x402_hsm_backup[0].id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_private_dns_zone" "x402_hsm_backup_blob" {
  count               = var.enable_x402_phase2_custody ? 1 : 0
  name                = "privatelink.blob.core.windows.net"
  resource_group_name = azurerm_resource_group.primary.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "x402_hsm_backup_blob" {
  count                 = var.enable_x402_phase2_custody ? 1 : 0
  name                  = "${local.name_prefix}-x402-hsm-backup-blob-link"
  resource_group_name   = azurerm_resource_group.primary.name
  private_dns_zone_name = azurerm_private_dns_zone.x402_hsm_backup_blob[0].name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "x402_hsm_backup_blob" {
  count               = var.enable_x402_phase2_custody ? 1 : 0
  name                = "${local.name_prefix}-x402-hsm-backup-pe"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "${local.name_prefix}-x402-hsm-backup-psc"
    private_connection_resource_id = azurerm_storage_account.x402_hsm_backup[0].id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "x402-hsm-backup-blob"
    private_dns_zone_ids = [azurerm_private_dns_zone.x402_hsm_backup_blob[0].id]
  }
}

# Microsoft documents Storage Blob Data Contributor as the minimum storage
# role for Managed HSM backup. The account is dedicated, so account scope is
# also destination scope and cannot reach any other Brain object store.
resource "azurerm_role_assignment" "x402_hsm_backup_storage" {
  count                = var.enable_x402_phase2_custody ? 1 : 0
  scope                = azurerm_storage_account.x402_hsm_backup[0].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.x402_hsm_backup[0].principal_id
  principal_type       = "ServicePrincipal"
}

# AzureRM does not expose the Managed HSM backup identity association. Manage
# only that control-plane property through AzAPI and leave the HSM lifecycle in
# AzureRM. The identity is attached while the HSM is inactive so the ceremony
# does not need an unreviewed control-plane mutation.
resource "azapi_update_resource" "x402_hsm_backup_identity" {
  count       = var.enable_x402_phase2_custody ? 1 : 0
  type        = "Microsoft.KeyVault/managedHSMs@2025-05-01"
  resource_id = azurerm_key_vault_managed_hardware_security_module.x402[0].id

  body = {
    identity = {
      type = "UserAssigned"
      userAssignedIdentities = {
        (azurerm_user_assigned_identity.x402_hsm_backup[0].id) = {}
      }
    }
  }

  depends_on = [azurerm_role_assignment.x402_hsm_backup_storage]
}

# Data-plane RBAC cannot be created until the security-domain ceremony has
# activated the HSM. Terraform creates this exact backup-only grant alongside
# the seller key after x402_hsm_activated becomes true. Restore, key, role, and
# security-domain permissions are intentionally absent.
resource "azurerm_key_vault_managed_hardware_security_module_role_definition" "x402_backup" {
  count          = var.x402_hsm_activated ? 1 : 0
  name           = "ad15aa7f-d0ef-4d5e-bc8e-69356f0f0d7e"
  managed_hsm_id = azurerm_key_vault_managed_hardware_security_module.x402[0].id
  role_name      = "Brain x402 HSM backup only"
  description    = "Start and observe full backups of the Base Sepolia x402 HSM."

  permission {
    data_actions = [
      "Microsoft.KeyVault/managedHsm/backup/start/action",
      "Microsoft.KeyVault/managedHsm/backup/status/action",
    ]
  }
}

resource "azurerm_key_vault_managed_hardware_security_module_role_assignment" "x402_backup" {
  count              = var.x402_hsm_activated ? 1 : 0
  name               = "ec655a4d-fb81-4827-baac-1ad41e7ffba7"
  managed_hsm_id     = azurerm_key_vault_managed_hardware_security_module.x402[0].id
  scope              = "/"
  role_definition_id = azurerm_key_vault_managed_hardware_security_module_role_definition.x402_backup[0].resource_manager_id
  principal_id       = azurerm_user_assigned_identity.x402_hsm_backup[0].principal_id

  depends_on = [azapi_update_resource.x402_hsm_backup_identity]
}

resource "azurerm_key_vault_managed_hardware_security_module_role_definition" "x402_signer" {
  count          = var.x402_hsm_activated ? 1 : 0
  name           = "5e20288a-bf2a-4cd7-a20b-1700541e1368"
  managed_hsm_id = azurerm_key_vault_managed_hardware_security_module.x402[0].id
  role_name      = "Brain x402 treasury sign only"
  description    = "Sign-only access to the Base Sepolia seller key. Transaction policy is enforced by the signer service."

  permission {
    data_actions = ["Microsoft.KeyVault/managedHsm/keys/sign/action"]
  }
}

resource "azurerm_key_vault_managed_hardware_security_module_key" "x402_sepolia_seller" {
  count          = var.x402_hsm_activated ? 1 : 0
  name           = "brain-x402-sepolia-seller"
  managed_hsm_id = azurerm_key_vault_managed_hardware_security_module.x402[0].id
  key_type       = "EC-HSM"
  curve          = "P-256K"
  key_opts       = ["sign"]
  tags           = merge(local.tags, { network = "eip155-84532" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_key_vault_managed_hardware_security_module_role_assignment" "x402_signer" {
  count              = var.x402_hsm_activated ? 1 : 0
  name               = "77eacbe8-8778-4b69-8935-bf919137c98d"
  managed_hsm_id     = azurerm_key_vault_managed_hardware_security_module.x402[0].id
  scope              = "/keys/${azurerm_key_vault_managed_hardware_security_module_key.x402_sepolia_seller[0].name}"
  role_definition_id = azurerm_key_vault_managed_hardware_security_module_role_definition.x402_signer[0].resource_manager_id
  principal_id       = azurerm_user_assigned_identity.x402_treasury_signer[0].principal_id
}

output "x402_custody_checkpoint" {
  value = var.enable_x402_phase2_custody ? {
    hsm_uri                   = azurerm_key_vault_managed_hardware_security_module.x402[0].hsm_uri
    signer_principal_id       = azurerm_user_assigned_identity.x402_treasury_signer[0].principal_id
    backup_principal_id       = azurerm_user_assigned_identity.x402_hsm_backup[0].principal_id
    hsm_activated             = var.x402_hsm_activated
    seller_key_versioned_id   = var.x402_hsm_activated ? azurerm_key_vault_managed_hardware_security_module_key.x402_sepolia_seller[0].versioned_id : null # gitleaks:allow non-secret Azure resource identifier
    recovery_container_id     = azurerm_storage_container.x402_hsm_recovery[0].id
    backup_container_id       = azurerm_storage_container.x402_hsm_backup[0].id
    recovery_envelope_keys    = 3
    recovery_quorum           = 2
    retained_recovery_holders = 2
  } : null
}
