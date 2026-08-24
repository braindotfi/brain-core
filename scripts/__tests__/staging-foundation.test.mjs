import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(path, "utf8");

test("staging bootstrap isolates state and GitHub OIDC from production", async () => {
  const [main, github, variables, backend] = await Promise.all([
    read("infra/bootstrap-staging/main.tf"),
    read("infra/bootstrap-staging/github.tf"),
    read("infra/bootstrap-staging/variables.tf"),
    read("infra/backend-staging.hcl"),
  ]);

  assert.match(main, /name\s+= var\.state_resource_group_name/);
  assert.match(main, /name\s+= var\.workload_resource_group_name/);
  assert.match(main, /shared_access_key_enabled\s+= false/);
  assert.match(main, /prevent_destroy\s+= true/);
  assert.match(main, /repo:\$\{var\.github_repository\}:environment:\$\{var\.github_environment\}/);
  assert.match(main, /role_definition_name\s+= "Contributor"/);
  assert.match(main, /role_definition_name\s+= "Role Based Access Control Administrator"/);
  assert.match(main, /scope\s+= azurerm_resource_group\.workload\.id/);
  assert.match(main, /role_definition_name\s+= "Reader"/);
  const subscriptionRole = main.match(
    /resource "azurerm_role_assignment" "github_staging_subscription_reader"[\s\S]*?\n}/,
  )?.[0];
  assert.ok(subscriptionRole);
  assert.match(subscriptionRole, /scope\s+= data\.azurerm_subscription\.staging\.id/);
  assert.doesNotMatch(subscriptionRole, /Contributor|Role Based Access Control Administrator/);
  assert.doesNotMatch(main, /client_secret|application_password/);
  assert.match(github, /resource "github_repository_environment" "staging"/);
  assert.match(github, /can_admins_bypass\s+= false/);
  assert.match(github, /prevent_self_review\s+= true/);
  assert.match(github, /protected_branches\s+= true/);
  assert.match(github, /AZURE_STAGING_CLIENT_ID/);
  assert.match(github, /AZURE_PRODUCTION_SUBSCRIPTION_ID_DENY/);
  assert.doesNotMatch(github, /AZURE_CLIENT_ID\b/);
  assert.match(variables, /brain-staging-tfstate-rg/);
  assert.match(variables, /brain-staging-rg/);
  assert.match(backend, /key\s+= "foundation\.terraform\.tfstate"/);
  assert.match(backend, /use_azuread_auth\s+= true/);
  assert.match(backend, /use_cli\s+= true/);
  assert.doesNotMatch(backend, /production/);
});

test("destroyable staging foundation exactly satisfies migration data sources", async () => {
  const [main, variables, outputs, migration, tfvars] = await Promise.all([
    read("infra/staging-foundation/main.tf"),
    read("infra/staging-foundation/variables.tf"),
    read("infra/staging-foundation/outputs.tf"),
    read("infra/staging-migration/main.tf"),
    read("infra/staging-foundation/staging.tfvars"),
  ]);

  for (const expected of [
    'resource "azurerm_virtual_network" "staging"',
    'resource "azurerm_subnet" "private_endpoints"',
    'resource "azurerm_key_vault" "staging"',
    'resource "azurerm_container_app_environment" "staging"',
    'resource "azurerm_container_registry" "staging"',
    'resource "azurerm_log_analytics_workspace" "staging"',
  ]) {
    assert.match(main, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(main, /public_network_access_enabled\s+= false/);
  assert.match(main, /rbac_authorization_enabled\s+= true/);
  assert.match(main, /purge_protection_enabled\s+= true/);
  assert.match(main, /privatelink\.vaultcore\.azure\.net/);
  assert.match(main, /role_definition_name\s+= "Key Vault Secrets Officer"/);
  assert.match(main, /role_definition_name\s+= "Key Vault Secrets User"/);
  assert.doesNotMatch(main, /resource "azurerm_resource_group"/);
  assert.doesNotMatch(main, /prevent_destroy/);
  assert.match(variables, /var\.resource_group_name == "brain-staging-rg"/);
  assert.match(variables, /var\.key_vault_name == "brain-staging-kv"/);
  assert.match(variables, /var\.container_app_environment_name == "brain-staging-env"/);
  assert.match(variables, /var\.acr_name == "brainstagingacr"/);
  assert.match(outputs, /key_vault_uri/);
  assert.match(tfvars, /vnet_address_space\s+= "10\.30\.0\.0\/16"/);

  for (const dataSource of [
    'data "azurerm_resource_group" "staging"',
    'data "azurerm_key_vault" "staging"',
    'data "azurerm_virtual_network" "staging"',
    'data "azurerm_subnet" "private_endpoints"',
    'data "azurerm_container_app_environment" "staging"',
    'data "azurerm_container_registry" "staging"',
  ]) {
    assert.match(migration, new RegExp(dataSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("staging workflows require reviewed exact plans and deny production", async () => {
  const [deploy, teardown] = await Promise.all([
    read(".github/workflows/deploy-azure-staging-foundation.yml"),
    read(".github/workflows/teardown-azure-staging-foundation.yml"),
  ]);

  for (const workflow of [deploy, teardown]) {
    assert.match(workflow, /environment: azure-staging-rehearsal/);
    assert.match(workflow, /AZURE_STAGING_CLIENT_ID/);
    assert.match(workflow, /AZURE_PRODUCTION_SUBSCRIPTION_ID_DENY/);
    assert.match(workflow, /staging subscription matches the denied production subscription/);
    assert.match(workflow, /actions\/download-artifact@v4/);
    assert.match(workflow, /terraform apply -input=false -no-color reviewed\/tfplan/);
    assert.doesNotMatch(workflow, /AZURE_CLIENT_ID\b/);
    assert.doesNotMatch(workflow, /terraform apply[^\n]*-auto-approve/);
  }

  assert.match(deploy, /APPLY-STAGING-FOUNDATION/);
  assert.match(deploy, /foundation deploy plan contains a delete or replacement/);
  assert.match(deploy, /plan contains a resource outside the staging foundation allowlist/);
  assert.match(teardown, /DESTROY-STAGING-FOUNDATION/);
  assert.match(teardown, /teardown plan contains an action other than delete/);
  assert.match(teardown, /dependent or unmanaged resources remain/);
});
