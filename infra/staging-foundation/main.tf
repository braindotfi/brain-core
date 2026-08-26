data "azurerm_client_config" "current" {}

data "azurerm_resource_group" "staging" {
  name = var.resource_group_name
}

locals {
  tags = {
    service     = "brain"
    environment = "staging"
    purpose     = "deploy-rehearsal-foundation"
    managed_by  = "terraform"
    owner       = var.rehearsal_owner
    expires_at  = var.rehearsal_expires_at
    github_run  = var.github_run_id
    lifecycle   = "ephemeral"
  }
}

check "staging_subscription" {
  assert {
    condition     = lower(data.azurerm_client_config.current.subscription_id) == lower(var.staging_subscription_id)
    error_message = "Authenticated Azure subscription does not match staging_subscription_id."
  }
}

check "staging_tenant" {
  assert {
    condition     = lower(data.azurerm_client_config.current.tenant_id) == lower(var.staging_tenant_id)
    error_message = "Authenticated Azure tenant does not match staging_tenant_id."
  }
}

check "resource_group_isolation" {
  assert {
    condition = (
      data.azurerm_resource_group.staging.name == "brain-staging-rg" &&
      try(data.azurerm_resource_group.staging.tags["environment"], "") == "staging"
    )
    error_message = "The target resource group is not the approved tagged staging boundary."
  }
}

check "separation_of_duties" {
  assert {
    condition     = lower(var.migration_operator_object_id) != lower(var.independent_verifier_object_id)
    error_message = "The migration operator and independent verifier must be different principals."
  }
}

resource "azurerm_virtual_network" "staging" {
  name                = var.vnet_name
  resource_group_name = data.azurerm_resource_group.staging.name
  location            = data.azurerm_resource_group.staging.location
  address_space       = [var.vnet_address_space]
  tags                = local.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = data.azurerm_resource_group.staging.name
  virtual_network_name = azurerm_virtual_network.staging.name
  address_prefixes     = [cidrsubnet(var.vnet_address_space, 7, 0)]
  service_endpoints    = ["Microsoft.KeyVault", "Microsoft.Storage"]

  delegation {
    name = "container-apps"

    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "private_endpoints" {
  name                 = "snet-private-endpoints"
  resource_group_name  = data.azurerm_resource_group.staging.name
  virtual_network_name = azurerm_virtual_network.staging.name
  address_prefixes     = [cidrsubnet(var.vnet_address_space, 8, 5)]
}

resource "azurerm_log_analytics_workspace" "staging" {
  name                = var.log_analytics_name
  resource_group_name = data.azurerm_resource_group.staging.name
  location            = data.azurerm_resource_group.staging.location
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

resource "azurerm_container_app_environment" "staging" {
  name                           = var.container_app_environment_name
  resource_group_name            = data.azurerm_resource_group.staging.name
  location                       = data.azurerm_resource_group.staging.location
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.staging.id
  infrastructure_subnet_id       = azurerm_subnet.apps.id
  internal_load_balancer_enabled = false
  tags                           = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_key_vault" "staging" {
  name                          = var.key_vault_name
  resource_group_name           = data.azurerm_resource_group.staging.name
  location                      = data.azurerm_resource_group.staging.location
  tenant_id                     = var.staging_tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  public_network_access_enabled = false
  purge_protection_enabled      = true
  soft_delete_retention_days    = 7
  tags                          = local.tags

  network_acls {
    bypass         = "None"
    default_action = "Deny"
  }
}

resource "azurerm_private_dns_zone" "key_vault" {
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = data.azurerm_resource_group.staging.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "key_vault" {
  name                  = "brain-staging-key-vault-link"
  resource_group_name   = data.azurerm_resource_group.staging.name
  private_dns_zone_name = azurerm_private_dns_zone.key_vault.name
  virtual_network_id    = azurerm_virtual_network.staging.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "key_vault" {
  name                = "brain-staging-key-vault-pe"
  resource_group_name = data.azurerm_resource_group.staging.name
  location            = data.azurerm_resource_group.staging.location
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "brain-staging-key-vault-psc"
    private_connection_resource_id = azurerm_key_vault.staging.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "key-vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.key_vault.id]
  }
}

resource "azurerm_container_registry" "staging" {
  name                          = var.acr_name
  resource_group_name           = data.azurerm_resource_group.staging.name
  location                      = data.azurerm_resource_group.staging.location
  sku                           = "Basic"
  admin_enabled                 = false
  public_network_access_enabled = true
  tags                          = local.tags
}

resource "azurerm_role_assignment" "migration_operator_evidence" {
  scope                = azurerm_key_vault.staging.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = var.migration_operator_object_id
}

resource "azurerm_role_assignment" "independent_verifier_evidence" {
  scope                = azurerm_key_vault.staging.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = var.independent_verifier_object_id
}
