output "resource_ids" {
  description = "Staging-only resource IDs used by follow-on rehearsal roots."
  value = {
    resource_group             = data.azurerm_resource_group.staging.id
    virtual_network            = azurerm_virtual_network.staging.id
    apps_subnet                = azurerm_subnet.apps.id
    private_endpoint_subnet    = azurerm_subnet.private_endpoints.id
    key_vault                  = azurerm_key_vault.staging.id
    container_apps_environment = azurerm_container_app_environment.staging.id
    container_registry         = azurerm_container_registry.staging.id
    log_analytics_workspace    = azurerm_log_analytics_workspace.staging.id
  }
}

output "key_vault_uri" {
  value = azurerm_key_vault.staging.vault_uri
}

output "container_registry_login_server" {
  value = azurerm_container_registry.staging.login_server
}

output "container_app_environment_default_domain" {
  value = azurerm_container_app_environment.staging.default_domain
}

output "expires_at" {
  value = var.rehearsal_expires_at
}
