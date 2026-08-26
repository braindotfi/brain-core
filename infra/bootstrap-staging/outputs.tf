output "github_environment_values" {
  description = "Non-secret values to configure on azure-staging-rehearsal after bootstrap."
  value = {
    AZURE_STAGING_CLIENT_ID                = azuread_application.github_staging.client_id
    AZURE_STAGING_TENANT_ID                = var.staging_tenant_id
    AZURE_STAGING_SUBSCRIPTION_ID          = var.staging_subscription_id
    AZURE_STAGING_EXPECTED_SUBSCRIPTION_ID = var.staging_subscription_id
    AZURE_STAGING_RESOURCE_GROUP           = azurerm_resource_group.workload.name
    AZURE_STAGING_STATE_ACCOUNT            = azurerm_storage_account.state.name
  }
}

output "backend_config" {
  description = "Non-secret values that must match infra/backend-staging.hcl."
  value = {
    resource_group_name  = azurerm_resource_group.state.name
    storage_account_name = azurerm_storage_account.state.name
    container_name       = azurerm_storage_container.state.name
    key                  = "foundation.terraform.tfstate"
  }
}

output "github_oidc_principal_id" {
  description = "Object ID of the staging-only GitHub service principal."
  value       = azuread_service_principal.github_staging.object_id
}

output "workload_resource_group_id" {
  value = azurerm_resource_group.workload.id
}

output "state_storage_account_id" {
  value = azurerm_storage_account.state.id
}
