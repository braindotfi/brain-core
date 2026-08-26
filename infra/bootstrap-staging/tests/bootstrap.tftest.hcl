mock_provider "azurerm" {}
mock_provider "azuread" {}
mock_provider "github" {}

override_data {
  target = data.azurerm_client_config.current
  values = {
    subscription_id = "11111111-1111-1111-1111-111111111111"
    tenant_id       = "22222222-2222-2222-2222-222222222222"
    object_id       = "33333333-3333-3333-3333-333333333333"
  }
}

override_data {
  target = data.azurerm_subscription.staging
  values = {
    id              = "/subscriptions/11111111-1111-1111-1111-111111111111"
    subscription_id = "11111111-1111-1111-1111-111111111111"
    tenant_id       = "22222222-2222-2222-2222-222222222222"
  }
}

override_data {
  target = data.azuread_client_config.current
  values = {
    tenant_id = "22222222-2222-2222-2222-222222222222"
    object_id = "33333333-3333-3333-3333-333333333333"
    client_id = "66666666-6666-6666-6666-666666666666"
  }
}

run "isolated_bootstrap_plan" {
  command = plan

  variables {
    staging_subscription_id         = "11111111-1111-1111-1111-111111111111"
    staging_tenant_id               = "22222222-2222-2222-2222-222222222222"
    owner                           = "test-owner"
    production_subscription_id_deny = "77777777-7777-7777-7777-777777777777"
    migration_operator_object_id    = "44444444-4444-4444-4444-444444444444"
    independent_verifier_object_id  = "55555555-5555-5555-5555-555555555555"
    github_reviewer_user_ids        = [12345]
  }

  assert {
    condition     = azurerm_resource_group.state.name == "brain-staging-tfstate-rg"
    error_message = "Staging state must use its isolated resource group."
  }

  assert {
    condition     = azurerm_resource_group.workload.name == "brain-staging-rg"
    error_message = "Staging workload resources must use their isolated resource group."
  }

  assert {
    condition     = !azurerm_storage_account.state.shared_access_key_enabled
    error_message = "Shared Key must remain disabled for staging Terraform state."
  }

  assert {
    condition     = azuread_application_federated_identity_credential.github_staging.subject == "repo:braindotfi/brain-core:environment:azure-staging-rehearsal"
    error_message = "GitHub OIDC trust escaped the protected staging environment."
  }

  assert {
    condition     = azurerm_role_assignment.github_workload_contributor.role_definition_name == "Contributor"
    error_message = "The staging workload principal must receive Contributor only through its scoped assignment."
  }

  assert {
    condition     = azurerm_role_assignment.github_staging_subscription_reader.role_definition_name == "Reader"
    error_message = "The subscription-wide staging assignment must remain read-only."
  }

  assert {
    condition     = github_repository_environment.staging.environment == "azure-staging-rehearsal" && github_repository_environment.staging.prevent_self_review
    error_message = "The protected GitHub staging environment is not configured."
  }
}
