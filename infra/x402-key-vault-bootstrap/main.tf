data "azurerm_client_config" "current" {}

locals {
  key_name = "brain-x402-sepolia-seller"
  tags = {
    service                     = "brain"
    environment                 = "production"
    component                   = "x402-treasury"
    network                     = "eip155-84532"
    custody                     = "key-vault-premium-bootstrap"
    x402_sepolia_bootstrap_only = "true"
    managed_by                  = "terraform"
    github_run                  = var.github_run_id
  }

  monitored_key_operations = toset([
    "KeyCreate",
    "KeyNewVersion",
    "KeyUpdate",
    "KeyDelete",
    "KeyRecover",
    "KeyPurge",
    "KeyBackup",
    "KeyRestore",
  ])
}

check "production_identity" {
  assert {
    condition = (
      lower(data.azurerm_client_config.current.subscription_id) == lower(var.subscription_id) &&
      lower(data.azurerm_client_config.current.tenant_id) == lower(var.tenant_id)
    )
    error_message = "Authenticated Azure identity does not target the approved production tenant and subscription."
  }
}

check "key_vault_testnet_boundary" {
  assert {
    condition     = var.chain_id == 84532
    error_message = "Key Vault Premium custody is a Base Sepolia-only bootstrap and rejects chain 8453."
  }
}

resource "azurerm_resource_group" "x402" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_virtual_network" "x402" {
  name                = "brain-x402-sepolia-vnet"
  resource_group_name = azurerm_resource_group.x402.name
  location            = azurerm_resource_group.x402.location
  address_space       = ["10.42.0.0/24"]
  tags                = local.tags
}

resource "azurerm_subnet" "private_endpoints" {
  name                 = "snet-private-endpoints"
  resource_group_name  = azurerm_resource_group.x402.name
  virtual_network_name = azurerm_virtual_network.x402.name
  address_prefixes     = ["10.42.0.0/27"]
}

resource "azurerm_subnet" "drill_runner" {
  name                 = "snet-restore-drill-runner"
  resource_group_name  = azurerm_resource_group.x402.name
  virtual_network_name = azurerm_virtual_network.x402.name
  address_prefixes     = ["10.42.0.32/27"]

  delegation {
    name = "container-instances"

    service_delegation {
      name    = "Microsoft.ContainerInstance/containerGroups"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

resource "azurerm_log_analytics_workspace" "x402" {
  name                = "brain-x402-sepolia-logs"
  resource_group_name = azurerm_resource_group.x402.name
  location            = azurerm_resource_group.x402.location
  sku                 = "PerGB2018"
  retention_in_days   = 90
  tags                = local.tags
}

resource "azurerm_key_vault" "source" {
  name                          = var.vault_name
  resource_group_name           = azurerm_resource_group.x402.name
  location                      = azurerm_resource_group.x402.location
  tenant_id                     = var.tenant_id
  sku_name                      = "premium"
  rbac_authorization_enabled    = true
  public_network_access_enabled = false
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  tags                          = local.tags

  network_acls {
    bypass         = "None"
    default_action = "Deny"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_key_vault" "restore_drill" {
  name                          = var.restore_vault_name
  resource_group_name           = azurerm_resource_group.x402.name
  location                      = azurerm_resource_group.x402.location
  tenant_id                     = var.tenant_id
  sku_name                      = "premium"
  rbac_authorization_enabled    = true
  public_network_access_enabled = false
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  tags = merge(local.tags, {
    component = "x402-restore-drill"
  })

  network_acls {
    bypass         = "None"
    default_action = "Deny"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_private_dns_zone" "key_vault" {
  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = azurerm_resource_group.x402.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "key_vault" {
  name                  = "brain-x402-key-vault-link"
  resource_group_name   = azurerm_resource_group.x402.name
  private_dns_zone_name = azurerm_private_dns_zone.key_vault.name
  virtual_network_id    = azurerm_virtual_network.x402.id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_endpoint" "source" {
  name                = "brain-x402-sepolia-kv-pe"
  resource_group_name = azurerm_resource_group.x402.name
  location            = azurerm_resource_group.x402.location
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "brain-x402-sepolia-kv-psc"
    private_connection_resource_id = azurerm_key_vault.source.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "key-vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.key_vault.id]
  }
}

resource "azurerm_private_endpoint" "restore_drill" {
  name                = "brain-x402-restore-kv-pe"
  resource_group_name = azurerm_resource_group.x402.name
  location            = azurerm_resource_group.x402.location
  subnet_id           = azurerm_subnet.private_endpoints.id
  tags                = local.tags

  private_service_connection {
    name                           = "brain-x402-restore-kv-psc"
    private_connection_resource_id = azurerm_key_vault.restore_drill.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "key-vault"
    private_dns_zone_ids = [azurerm_private_dns_zone.key_vault.id]
  }
}

resource "azurerm_user_assigned_identity" "signer" {
  name                = "brain-x402-treasury-signer"
  resource_group_name = azurerm_resource_group.x402.name
  location            = azurerm_resource_group.x402.location
  tags                = local.tags
}

# Creating the key through ARM avoids a data-plane connection from the hosted
# Terraform runner. The deployed vault is private before the key exists.
resource "azapi_resource" "seller_key" {
  type      = "Microsoft.KeyVault/vaults/keys@2024-11-01"
  name      = local.key_name
  parent_id = azurerm_key_vault.source.id

  body = {
    properties = {
      kty       = "EC-HSM"
      curveName = "P-256K"
      keyOps    = ["sign"]
      attributes = {
        enabled    = true
        exportable = false
      }
    }
    tags = local.tags
  }

  response_export_values = ["properties.keyUriWithVersion"]

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_role_definition" "signer" {
  name        = "brain-x402-sepolia-sign-only"
  scope       = azurerm_resource_group.x402.id
  description = "Sign only with the exact Base Sepolia x402 seller key."

  permissions {
    data_actions = ["Microsoft.KeyVault/vaults/keys/sign/action"]
  }

  assignable_scopes = [azurerm_resource_group.x402.id]
}

resource "azurerm_role_assignment" "signer" {
  scope              = azapi_resource.seller_key.id
  role_definition_id = azurerm_role_definition.signer.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.signer.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_monitor_action_group" "custody" {
  name                = "brain-x402-custody-alerts"
  resource_group_name = azurerm_resource_group.x402.name
  short_name          = "x402custody"
  tags                = local.tags

  email_receiver {
    name                    = "treasury"
    email_address           = var.treasury_alert_email
    use_common_alert_schema = true
  }

  email_receiver {
    name                    = "security"
    email_address           = var.security_alert_email
    use_common_alert_schema = true
  }
}

resource "azurerm_monitor_diagnostic_setting" "source_vault" {
  name                       = "brain-x402-source-audit"
  target_resource_id         = azurerm_key_vault.source.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.x402.id

  enabled_log {
    category = "AuditEvent"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "restore_vault" {
  name                       = "brain-x402-restore-audit"
  target_resource_id         = azurerm_key_vault.restore_drill.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.x402.id

  enabled_log {
    category = "AuditEvent"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_activity_log_alert" "administrative_change" {
  name                = "brain-x402-administrative-change"
  resource_group_name = azurerm_resource_group.x402.name
  location            = "global"
  scopes              = [azurerm_resource_group.x402.id]
  description         = "Alert on role, networking, vault, key, and identity control-plane changes."

  criteria {
    category = "Administrative"
  }

  action {
    action_group_id = azurerm_monitor_action_group.custody.id
  }

  tags = local.tags
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "sensitive_key_operation" {
  name                 = "brain-x402-sensitive-key-operation"
  resource_group_name  = azurerm_resource_group.x402.name
  location             = azurerm_resource_group.x402.location
  evaluation_frequency = "PT5M"
  window_duration      = "PT5M"
  scopes               = [azurerm_log_analytics_workspace.x402.id]
  severity             = 0
  description          = "Alert on key creation, versions, disablement, deletion, recovery, purge, backup, or restore."

  criteria {
    query                   = <<-KQL
      AzureDiagnostics
      | where ResourceProvider == "MICROSOFT.KEYVAULT"
      | where OperationName in (${join(", ", [for operation in local.monitored_key_operations : format("\"%s\"", operation)])})
    KQL
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.custody.id]
  }

  tags = local.tags
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "anomalous_sign" {
  name                 = "brain-x402-anomalous-sign"
  resource_group_name  = azurerm_resource_group.x402.name
  location             = azurerm_resource_group.x402.location
  evaluation_frequency = "PT1M"
  window_duration      = "PT5M"
  scopes               = [azurerm_log_analytics_workspace.x402.id]
  severity             = 0
  description          = "Alert on failed signing or signing volume above the adapter's 20 operations per second cap."

  criteria {
    query                   = <<-KQL
      AzureDiagnostics
      | where ResourceProvider == "MICROSOFT.KEYVAULT"
      | where OperationName == "KeySign"
      | summarize attempts=count(), failures=countif(httpStatusCode_d >= 400) by bin(TimeGenerated, 1m)
      | where failures > 0 or attempts > 1200
    KQL
    time_aggregation_method = "Count"
    threshold               = 0
    operator                = "GreaterThan"

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.custody.id]
  }

  tags = local.tags
}
