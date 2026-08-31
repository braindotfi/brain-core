data "azurerm_client_config" "current" {}
data "azurerm_subscription" "staging" {}
data "azuread_client_config" "current" {}

locals {
  tags = {
    service     = "brain"
    environment = "staging"
    purpose     = "rehearsal-bootstrap"
    managed_by  = "terraform"
    owner       = var.owner
    lifecycle   = "retained-bootstrap"
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

check "migration_separation_of_duties" {
  assert {
    condition     = lower(var.migration_operator_object_id) != lower(var.independent_verifier_object_id)
    error_message = "The migration operator and independent verifier must be different principals."
  }
}

resource "azurerm_resource_group" "state" {
  name     = var.state_resource_group_name
  location = var.location
  tags     = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_resource_group" "workload" {
  name     = var.workload_resource_group_name
  location = var.location
  tags     = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_account" "state" {
  name                             = var.state_storage_account_name
  resource_group_name              = azurerm_resource_group.state.name
  location                         = azurerm_resource_group.state.location
  account_tier                     = "Standard"
  account_replication_type         = "ZRS"
  account_kind                     = "StorageV2"
  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  public_network_access_enabled    = true
  shared_access_key_enabled        = false
  allow_nested_items_to_be_public  = false
  cross_tenant_replication_enabled = false
  local_user_enabled               = false
  sftp_enabled                     = false
  tags                             = local.tags

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = 30
    }

    container_delete_retention_policy {
      days = 30
    }
  }

  network_rules {
    default_action = "Allow"
    bypass         = ["None"]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "state" {
  name                  = var.state_container_name
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

resource "azuread_application" "github_staging" {
  display_name     = "brain-github-azure-staging"
  sign_in_audience = "AzureADMyOrg"
  owners           = [data.azuread_client_config.current.object_id]
}

resource "azuread_service_principal" "github_staging" {
  client_id                    = azuread_application.github_staging.client_id
  app_role_assignment_required = false
  owners                       = [data.azuread_client_config.current.object_id]
}

resource "azuread_application_federated_identity_credential" "github_staging" {
  application_id = azuread_application.github_staging.id
  display_name   = "brain-core-azure-staging-rehearsal"
  description    = "GitHub Actions staging foundation plans and approved applies."
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = "repo:${var.github_repository}:environment:${var.github_environment}"
}

resource "azurerm_role_assignment" "github_workload_contributor" {
  scope                            = azurerm_resource_group.workload.id
  role_definition_name             = "Contributor"
  principal_id                     = azuread_service_principal.github_staging.object_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "github_workload_rbac" {
  scope                            = azurerm_resource_group.workload.id
  role_definition_name             = "Role Based Access Control Administrator"
  principal_id                     = azuread_service_principal.github_staging.object_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "github_state_blob" {
  scope                            = azurerm_storage_account.state.id
  role_definition_name             = "Storage Blob Data Contributor"
  principal_id                     = azuread_service_principal.github_staging.object_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "github_staging_subscription_reader" {
  scope                            = data.azurerm_subscription.staging.id
  role_definition_name             = "Reader"
  principal_id                     = azuread_service_principal.github_staging.object_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}
