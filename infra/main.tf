# Brain Azure infrastructure.
# Stage-8 implementation of the stack defined in §2 of Brain_MVP_Architecture.md
# and §10 of Brain_Engineering_Standards.md.
#
# Provisions (staging + production):
#   - Resource groups (primary eastus, backup westus3 for prod only)
#   - Azure Container Apps environment + managed identity
#   - Azure Database for PostgreSQL flexible server + pgvector
#   - Azure Cache for Redis
#   - Azure Blob Storage with immutable blob policy
#   - Azure Key Vault (managed-identity-only access)
#   - Azure Container Registry
#   - Azure Front Door (public API front)
#
# Datadog / Azure Monitor integration is wired via diagnostic settings
# pointing at a Log Analytics workspace + Datadog Azure integration.

locals {
  name_prefix = "brain-${var.environment}"
  tags = {
    service     = "brain"
    environment = var.environment
    managed_by  = "terraform"
  }
  is_prod = var.environment == "production"
}

resource "azurerm_resource_group" "primary" {
  name     = "${local.name_prefix}-rg"
  location = var.primary_location
  tags     = local.tags
}

resource "azurerm_resource_group" "backup" {
  count    = local.is_prod ? 1 : 0
  name     = "${local.name_prefix}-rg-backup"
  location = var.backup_location
  tags     = local.tags
}

# ---------------------------------------------------------------------------
# Managed identity used by services to pull secrets / blobs.
# ---------------------------------------------------------------------------
resource "azurerm_user_assigned_identity" "services" {
  name                = "${local.name_prefix}-services"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  tags                = local.tags
}

# ---------------------------------------------------------------------------
# Key Vault (§10.4 — all secrets live here)
# ---------------------------------------------------------------------------
data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "main" {
  name                       = "${local.name_prefix}-kv"
  resource_group_name        = azurerm_resource_group.primary.name
  location                   = azurerm_resource_group.primary.location
  sku_name                   = "standard"
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  enable_rbac_authorization  = true
  purge_protection_enabled   = local.is_prod
  soft_delete_retention_days = 90
  tags                       = local.tags
}

resource "azurerm_role_assignment" "services_kv_read" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.services.principal_id
}

data "azurerm_key_vault_secret" "openai_api_key" {
  count        = contains(var.services, "agents") ? 1 : 0
  name         = var.openai_api_key_secret_name
  key_vault_id = azurerm_key_vault.main.id
}

data "azurerm_key_vault_secret" "brain_agents_inbound_secret" {
  count        = contains(var.services, "agents") ? 1 : 0
  name         = var.brain_agents_inbound_secret_name
  key_vault_id = azurerm_key_vault.main.id
}

data "azurerm_key_vault_secret" "brain_api_token" {
  count        = contains(var.services, "agents") ? 1 : 0
  name         = var.brain_api_token_secret_name
  key_vault_id = azurerm_key_vault.main.id
}

# ---------------------------------------------------------------------------
# Postgres Flexible Server with pgvector
# ---------------------------------------------------------------------------
resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "${local.name_prefix}-pg"
  resource_group_name           = azurerm_resource_group.primary.name
  location                      = azurerm_resource_group.primary.location
  version                       = "16"
  administrator_login           = "brain_admin"
  administrator_password        = random_password.pg_admin.result
  storage_mb                    = local.is_prod ? 262144 : 32768
  sku_name                      = local.is_prod ? "GP_Standard_D4s_v3" : "B_Standard_B2s"
  public_network_access_enabled = false
  zone                          = "1"
  tags                          = local.tags
}

resource "azurerm_postgresql_flexible_server_database" "brain" {
  name      = "brain"
  server_id = azurerm_postgresql_flexible_server.main.id
  collation = "en_US.utf8"
  charset   = "UTF8"
}

# pgvector extension allowlisting — required before CREATE EXTENSION works.
resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "VECTOR,PGCRYPTO,UUID-OSSP"
}

resource "random_password" "pg_admin" {
  length  = 32
  special = true
}

resource "azurerm_key_vault_secret" "pg_admin" {
  name         = "postgres-admin-password"
  value        = random_password.pg_admin.result
  key_vault_id = azurerm_key_vault.main.id
}

# ---------------------------------------------------------------------------
# Redis (Azure Cache for Redis) — sessions + BullMQ queues
# ---------------------------------------------------------------------------
resource "azurerm_redis_cache" "main" {
  name                = "${local.name_prefix}-redis"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  capacity            = local.is_prod ? 1 : 0
  family              = local.is_prod ? "P" : "C"
  sku_name            = local.is_prod ? "Premium" : "Basic"
  non_ssl_port_enabled = false
  minimum_tls_version = "1.2"
  tags                = local.tags
}

# ---------------------------------------------------------------------------
# Blob Storage with immutable blob policy — Raw layer substrate (§3 Layer 1)
# ---------------------------------------------------------------------------
resource "azurerm_storage_account" "raw" {
  name                     = replace("${local.name_prefix}raw", "-", "")
  resource_group_name      = azurerm_resource_group.primary.name
  location                 = azurerm_resource_group.primary.location
  account_tier             = "Standard"
  account_replication_type = local.is_prod ? "GRS" : "LRS"
  min_tls_version          = "TLS1_2"
  allow_nested_items_to_be_public = false
  blob_properties {
    versioning_enabled       = true
    change_feed_enabled      = true
    last_access_time_enabled = true
  }
  tags = local.tags
}

resource "azurerm_storage_container" "raw_artifacts" {
  name                  = "raw-artifacts"
  storage_account_id    = azurerm_storage_account.raw.id
  container_access_type = "private"
}

resource "azurerm_storage_container_immutability_policy" "raw_artifacts" {
  storage_container_resource_manager_id = azurerm_storage_container.raw_artifacts.resource_manager_id
  immutability_period_in_days           = local.is_prod ? 2555 : 30  # 7 years prod, 30 days staging
  protected_append_writes_all_enabled   = false
  protected_append_writes_enabled       = false
}

resource "azurerm_storage_container" "audit_exports" {
  name                  = "audit-exports"
  storage_account_id    = azurerm_storage_account.raw.id
  container_access_type = "private"
}

# ---------------------------------------------------------------------------
# Container Registry + Container Apps Environment
# ---------------------------------------------------------------------------
resource "azurerm_container_registry" "main" {
  name                = replace("${local.name_prefix}acr", "-", "")
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  sku                 = local.is_prod ? "Premium" : "Standard"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_role_assignment" "services_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.services.principal_id
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${local.name_prefix}-logs"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  sku                 = "PerGB2018"
  retention_in_days   = local.is_prod ? 90 : 30
  tags                = local.tags
}

resource "azurerm_container_app_environment" "main" {
  name                       = "${local.name_prefix}-env"
  resource_group_name        = azurerm_resource_group.primary.name
  location                   = azurerm_resource_group.primary.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  tags                       = local.tags
}

# One Container App per service. Revision-based blue/green per §10.3.
# Override var.services in a tfvars file to deploy a subset (e.g. poc.tfvars).
locals {
  services                   = toset(var.services)
  deploys_agents             = contains(var.services, "agents")
  api_base_url               = local.is_prod ? "https://api.brain.fi" : "https://api.sandbox.brain.fi"
  document_extract_agent_url = "https://${local.name_prefix}-agents.internal.${azurerm_container_app_environment.main.default_domain}"
  service_ports = merge(
    { for service in var.services : service => 8080 },
    { agents = 8001 },
  )
}

resource "azurerm_container_app" "service" {
  for_each                     = local.services
  name                         = "${local.name_prefix}-${each.key}"
  resource_group_name          = azurerm_resource_group.primary.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Multiple"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.services.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.services.id
  }

  template {
    min_replicas = local.is_prod ? 2 : 1
    max_replicas = local.is_prod ? 10 : 3

    container {
      name   = each.key
      image  = "${azurerm_container_registry.main.login_server}/brain-${each.key}:latest"
      cpu    = 0.5
      memory = "1.0Gi"
      env {
        name  = "NODE_ENV"
        value = var.environment
      }
      env {
        name  = "BRAIN_ENV"
        value = var.environment
      }
      env {
        name  = "SERVICE_NAME"
        value = "brain-${each.key}"
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name        = "REDIS_URL"
        secret_name = "redis-url"
      }
      dynamic "env" {
        for_each = each.key == "api" && local.deploys_agents ? [1] : []
        content {
          name  = "DOCUMENT_EXTRACT_AGENT_URL"
          value = local.document_extract_agent_url
        }
      }
      dynamic "env" {
        for_each = (each.key == "api" || each.key == "agents") && local.deploys_agents ? [1] : []
        content {
          name        = "BRAIN_AGENTS_INBOUND_SECRET"
          secret_name = "brain-agents-inbound-secret"
        }
      }
      dynamic "env" {
        for_each = each.key == "agents" ? [1] : []
        content {
          name        = "OPENAI_API_KEY"
          secret_name = "openai-api-key"
        }
      }
      dynamic "env" {
        for_each = each.key == "agents" ? [1] : []
        content {
          name        = "BRAIN_API_TOKEN"
          secret_name = "brain-api-token"
        }
      }
      dynamic "env" {
        for_each = each.key == "agents" ? [1] : []
        content {
          name  = "BRAIN_API_BASE_URL"
          value = local.api_base_url
        }
      }
    }
  }

  secret {
    name                = "database-url"
    identity            = azurerm_user_assigned_identity.services.id
    key_vault_secret_id = azurerm_key_vault_secret.database_url.id
  }

  secret {
    name                = "redis-url"
    identity            = azurerm_user_assigned_identity.services.id
    key_vault_secret_id = azurerm_key_vault_secret.redis_url.id
  }

  dynamic "secret" {
    for_each = local.deploys_agents ? [1] : []
    content {
      name                = "openai-api-key"
      identity            = azurerm_user_assigned_identity.services.id
      key_vault_secret_id = data.azurerm_key_vault_secret.openai_api_key[0].id
    }
  }

  dynamic "secret" {
    for_each = local.deploys_agents ? [1] : []
    content {
      name                = "brain-agents-inbound-secret"
      identity            = azurerm_user_assigned_identity.services.id
      key_vault_secret_id = data.azurerm_key_vault_secret.brain_agents_inbound_secret[0].id
    }
  }

  dynamic "secret" {
    for_each = local.deploys_agents ? [1] : []
    content {
      name                = "brain-api-token"
      identity            = azurerm_user_assigned_identity.services.id
      key_vault_secret_id = data.azurerm_key_vault_secret.brain_api_token[0].id
    }
  }

  ingress {
    external_enabled = each.key == "api"
    target_port      = local.service_ports[each.key]
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

resource "azurerm_key_vault_secret" "database_url" {
  name         = "database-url"
  value        = "postgres://brain_admin:${random_password.pg_admin.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/brain?sslmode=require"
  key_vault_id = azurerm_key_vault.main.id
}

resource "azurerm_key_vault_secret" "redis_url" {
  name         = "redis-url"
  value        = "rediss://:${azurerm_redis_cache.main.primary_access_key}@${azurerm_redis_cache.main.hostname}:${azurerm_redis_cache.main.ssl_port}"
  key_vault_id = azurerm_key_vault.main.id
}

# ---------------------------------------------------------------------------
# Front Door (public API front, §10.3 traffic shifting via revision weights)
# ---------------------------------------------------------------------------
resource "azurerm_cdn_frontdoor_profile" "main" {
  name                = "${local.name_prefix}-fd"
  resource_group_name = azurerm_resource_group.primary.name
  sku_name            = local.is_prod ? "Premium_AzureFrontDoor" : "Standard_AzureFrontDoor"
  tags                = local.tags
}

# Endpoint + origin wiring kept separate from this file to reduce plan size.
# See ./frontdoor.tf in the post-stage-8 bundle that folds in staging URL
# bindings and WAF policy.

# ---------------------------------------------------------------------------
# Outputs consumed by CI
# ---------------------------------------------------------------------------
output "resource_group" {
  value = azurerm_resource_group.primary.name
}
output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}
output "container_app_env_id" {
  value = azurerm_container_app_environment.main.id
}
output "key_vault_name" {
  value = azurerm_key_vault.main.name
}
output "postgres_fqdn" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}
output "redis_hostname" {
  value = azurerm_redis_cache.main.hostname
}
