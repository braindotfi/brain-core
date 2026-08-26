locals {
  github_repository_name = split("/", var.github_repository)[1]
  github_environment_secrets = {
    AZURE_STAGING_CLIENT_ID       = azuread_application.github_staging.client_id
    AZURE_STAGING_TENANT_ID       = var.staging_tenant_id
    AZURE_STAGING_SUBSCRIPTION_ID = var.staging_subscription_id
  }
  github_environment_variables = {
    AZURE_STAGING_EXPECTED_SUBSCRIPTION_ID       = var.staging_subscription_id
    AZURE_PRODUCTION_SUBSCRIPTION_ID_DENY        = var.production_subscription_id_deny
    AZURE_STAGING_RESOURCE_GROUP                 = azurerm_resource_group.workload.name
    AZURE_STAGING_STATE_ACCOUNT                  = azurerm_storage_account.state.name
    AZURE_STAGING_MIGRATION_OPERATOR_OBJECT_ID   = var.migration_operator_object_id
    AZURE_STAGING_INDEPENDENT_VERIFIER_OBJECT_ID = var.independent_verifier_object_id
    AZURE_STAGING_REHEARSAL_OWNER                = var.owner
  }
}

resource "github_repository_environment" "staging" {
  repository          = local.github_repository_name
  environment         = var.github_environment
  can_admins_bypass   = false
  prevent_self_review = true

  reviewers {
    users = var.github_reviewer_user_ids
  }

  deployment_branch_policy {
    protected_branches     = true
    custom_branch_policies = false
  }
}

resource "github_actions_environment_secret" "staging" {
  for_each = local.github_environment_secrets

  repository  = local.github_repository_name
  environment = github_repository_environment.staging.environment
  secret_name = each.key
  value       = each.value
}

resource "github_actions_environment_variable" "staging" {
  for_each = local.github_environment_variables

  repository    = local.github_repository_name
  environment   = github_repository_environment.staging.environment
  variable_name = each.key
  value         = each.value
}
