mock_provider "azurerm" {}

override_data {
  target = data.azurerm_client_config.current
  values = {
    subscription_id = "11111111-1111-1111-1111-111111111111"
    tenant_id       = "22222222-2222-2222-2222-222222222222"
    object_id       = "33333333-3333-3333-3333-333333333333"
  }
}

override_data {
  target = data.azurerm_resource_group.staging
  values = {
    id       = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/brain-staging-rg"
    name     = "brain-staging-rg"
    location = "canadacentral"
    tags = {
      environment = "staging"
    }
  }
}

run "isolated_foundation_plan" {
  command = plan

  variables {
    staging_subscription_id        = "11111111-1111-1111-1111-111111111111"
    staging_tenant_id              = "22222222-2222-2222-2222-222222222222"
    migration_operator_object_id   = "44444444-4444-4444-4444-444444444444"
    independent_verifier_object_id = "55555555-5555-5555-5555-555555555555"
    rehearsal_owner                = "test-owner"
    rehearsal_expires_at           = "2026-08-25T12:00:00Z"
    github_run_id                  = "123456"
  }

  assert {
    condition     = azurerm_virtual_network.staging.name == "brain-staging-vnet"
    error_message = "The staging VNet name drifted."
  }

  assert {
    condition     = azurerm_subnet.private_endpoints.name == "snet-private-endpoints"
    error_message = "The private endpoint subnet required by migration intake is absent."
  }

  assert {
    condition     = azurerm_key_vault.staging.name == "brain-staging-kv" && !azurerm_key_vault.staging.public_network_access_enabled
    error_message = "The staging Key Vault must be private and use the reviewed name."
  }

  assert {
    condition     = azurerm_container_app_environment.staging.name == "brain-staging-env"
    error_message = "The staging Container Apps environment name drifted."
  }

  assert {
    condition     = azurerm_container_registry.staging.name == "brainstagingacr" && !azurerm_container_registry.staging.admin_enabled
    error_message = "The staging ACR must use the reviewed name with admin access disabled."
  }

  assert {
    condition     = azurerm_role_assignment.migration_operator_evidence.principal_id != azurerm_role_assignment.independent_verifier_evidence.principal_id
    error_message = "Evidence operator and verifier roles must remain separated."
  }
}
