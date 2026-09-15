# RFC 0012 Phase 2 custody foundation. The first apply creates an inactive,
# private Managed HSM and immutable geo-redundant recovery store. Activation
# uses five offline-held recovery keys with a quorum of three and is never run
# by Terraform. Only after that ceremony may x402_hsm_activated become true.

resource "azurerm_user_assigned_identity" "x402_treasury_signer" {
  count               = var.enable_x402_phase2_custody ? 1 : 0
  name                = "brain-x402-treasury-signer"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  tags                = merge(local.tags, { component = "x402-treasury" })
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
    hsm_uri                  = azurerm_key_vault_managed_hardware_security_module.x402[0].hsm_uri
    signer_principal_id      = azurerm_user_assigned_identity.x402_treasury_signer[0].principal_id
    hsm_activated            = var.x402_hsm_activated
    seller_key_versioned_id  = var.x402_hsm_activated ? azurerm_key_vault_managed_hardware_security_module_key.x402_sepolia_seller[0].versioned_id : null # gitleaks:allow non-secret Azure resource identifier
    recovery_container_id    = azurerm_storage_container.x402_hsm_recovery[0].id
    recovery_quorum          = 3
    recovery_custodian_count = 5
  } : null
}
