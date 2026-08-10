# Brain Azure infrastructure.
#
# Stack defined in §2 of Brain_MVP_Architecture.md and §10 of
# Brain_Engineering_Standards.md; topology in
# docs/diligence/diagrams/production-cutover-topology.mmd.
#
# Provisions:
#   - Resource group + VNet (network.tf)
#   - User-assigned managed identity used for every data-plane authentication
#   - Key Vault (secrets.tf holds the secret surface)
#   - Postgres Flexible Server (VNet-integrated) with pgvector
#   - Azure Cache for Redis (private endpoint)
#   - Blob Storage with an immutable container for the Raw layer
#   - Container Registry + Container Apps environment (VNet-injected)
#   - Container Apps: api (public ingress), worker (no ingress), agents (internal)
#   - Container App Jobs: migrate, db-roles
#   - Front Door (frontdoor.tf, off until DNS cutover)

locals {
  name_prefix = "brain-${var.environment}"
  tags = {
    service     = "brain"
    environment = var.environment
    managed_by  = "terraform"
  }
}

resource "azurerm_resource_group" "primary" {
  name     = "${local.name_prefix}-rg"
  location = var.primary_location
  tags     = local.tags
}

# ---------------------------------------------------------------------------
# Managed identity used by services to pull images and read secrets.
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
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 90
  tags                       = local.tags

  # Blocker #2: the scaffold denied all traffic with no exception, so Terraform
  # could not write a single secret over the data plane after creating the
  # vault. Apps reach the vault over the service endpoint on the apps subnet;
  # the operator IP exists only to seed secrets and should be removed once CI
  # owns rotation.
  network_acls {
    bypass                     = "AzureServices"
    default_action             = var.key_vault_network_default_action
    ip_rules                   = var.operator_ip == null ? var.operator_extra_ip_ranges : concat([var.operator_ip], var.operator_extra_ip_ranges)
    virtual_network_subnet_ids = [azurerm_subnet.apps.id]
  }
}

# The TERRAFORM principal (the brain-terraform service principal, not a human)
# needs data-plane rights to write secrets. With RBAC authorization enabled the
# control-plane owner role is NOT sufficient.
resource "azurerm_role_assignment" "operator_kv_admin" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = data.azurerm_client_config.current.object_id
}

# The HUMAN operator, separately. Terraform creates the operator-supplied
# secrets as placeholders; a person then puts the real values in. Secrets
# Officer rather than Administrator: it covers secrets and nothing else (no
# keys, no certificates, no vault-level policy).
resource "azurerm_role_assignment" "operator_human_kv_secrets" {
  count                = var.operator_object_id == null ? 0 : 1
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = var.operator_object_id
}

resource "azurerm_role_assignment" "services_kv_read" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.services.principal_id
}

# ---------------------------------------------------------------------------
# Postgres Flexible Server with pgvector
# ---------------------------------------------------------------------------
resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "${local.name_prefix}-pg"
  resource_group_name           = azurerm_resource_group.primary.name
  location                      = azurerm_resource_group.primary.location
  version                       = "16"
  administrator_login           = "brain"
  administrator_password        = random_password.pg_admin.result
  storage_mb                    = var.postgres_storage_mb
  sku_name                      = var.postgres_sku_name
  backup_retention_days         = var.postgres_backup_retention_days
  public_network_access_enabled = false
  zone                          = "1"
  tags                          = local.tags

  # Blocker #1: private access requires BOTH a delegated subnet and a private
  # DNS zone. Neither existed in the scaffold.
  delegated_subnet_id = azurerm_subnet.postgres.id
  private_dns_zone_id = azurerm_private_dns_zone.postgres.id

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]

  lifecycle {
    # Azure grows storage but never shrinks it; a lowered value would force
    # replacement of the production database.
    prevent_destroy = true
  }
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

# special = false: this password is interpolated into a postgres:// URL and the
# default special set (@ : / ?) silently corrupts the connection string.
resource "random_password" "pg_admin" {
  length  = 40
  special = false
}

resource "azurerm_key_vault_secret" "pg_admin" {
  name         = "postgres-admin-password"
  value        = random_password.pg_admin.result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.operator_kv_admin]
}

# ---------------------------------------------------------------------------
# Redis -- Azure Managed Redis (azurerm_managed_redis)
#
# The classic Azure Cache for Redis resource is RETIRED for new creates: the
# API rejects it with "Azure Cache for Redis is retiring, create Azure Managed
# Redis instance instead". The enterprise-cluster resource that replaced it is
# itself deprecated and goes away in provider v5.0, so this uses the current
# resource directly rather than something we would have to migrate again.
#
# Two settings below are correctness-critical for BullMQ, not preferences:
#
#   eviction_policy = "NoEviction"
#     Any eviction policy lets Redis silently DROP queue jobs and idempotency
#     keys under memory pressure. For a queue backing a money path, dropped
#     jobs are lost work with no error surfaced anywhere.
#
#   clustering_policy = "EnterpriseCluster"
#     BullMQ drives multi-key Lua scripts. Under OSSCluster those fail with
#     CROSSSLOT unless every key is hash-tagged. EnterpriseCluster presents a
#     single non-clustered endpoint via the proxy, which is what ioredis and
#     BullMQ expect.
# ---------------------------------------------------------------------------
resource "azurerm_managed_redis" "main" {
  name                = "${local.name_prefix}-redis"
  resource_group_name = azurerm_resource_group.primary.name
  location            = azurerm_resource_group.primary.location
  sku_name            = var.redis_sku_name
  tags                = local.tags

  # Reached only over the private endpoint in network.tf.
  public_network_access = "Disabled"

  default_database {
    client_protocol                    = "Encrypted"
    clustering_policy                  = "EnterpriseCluster"
    eviction_policy                    = "NoEviction"
    access_keys_authentication_enabled = true
  }
}

resource "azurerm_key_vault_secret" "redis_url" {
  name         = "redis-url"
  value        = "rediss://:${azurerm_managed_redis.main.default_database[0].primary_access_key}@${azurerm_managed_redis.main.hostname}:${azurerm_managed_redis.main.default_database[0].port}"
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.operator_kv_admin]
}

# ---------------------------------------------------------------------------
# Blob Storage with immutable blob policy — Raw layer substrate (§3 Layer 1)
# ---------------------------------------------------------------------------
resource "azurerm_storage_account" "raw" {
  name                            = replace("${local.name_prefix}raw", "-", "")
  resource_group_name             = azurerm_resource_group.primary.name
  location                        = azurerm_resource_group.primary.location
  account_tier                    = "Standard"
  account_replication_type        = var.storage_replication_type
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  tags                            = local.tags

  blob_properties {
    versioning_enabled       = true
    change_feed_enabled      = true
    last_access_time_enabled = true
  }

  network_rules {
    default_action             = "Deny"
    bypass                     = ["AzureServices"]
    ip_rules                   = var.operator_ip == null ? [] : [split("/", var.operator_ip)[0]]
    virtual_network_subnet_ids = [azurerm_subnet.apps.id]
  }
}

resource "azurerm_storage_container" "raw_artifacts" {
  name                  = "raw-artifacts"
  storage_account_id    = azurerm_storage_account.raw.id
  container_access_type = "private"
}

resource "azurerm_storage_container_immutability_policy" "raw_artifacts" {
  storage_container_resource_manager_id = azurerm_storage_container.raw_artifacts.id
  immutability_period_in_days           = var.raw_immutability_days
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
  sku                 = var.acr_sku
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
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

resource "azurerm_container_app_environment" "main" {
  name                       = "${local.name_prefix}-env"
  resource_group_name        = azurerm_resource_group.primary.name
  location                   = azurerm_resource_group.primary.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  tags                       = local.tags

  # Blocker #1: without VNet injection the apps cannot reach a private Postgres.
  infrastructure_subnet_id       = azurerm_subnet.apps.id
  internal_load_balancer_enabled = false

  # Azure creates this profile itself on any Consumption environment. Leaving
  # it undeclared does not opt out of it -- it produces a PERPETUAL diff where
  # every plan tries to delete a profile the platform immediately recreates,
  # churning revisions of live containers on each apply.
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

# ---------------------------------------------------------------------------
# Shared container configuration
# ---------------------------------------------------------------------------
locals {
  deploys_agents = contains(var.services, "agents")

  api_image    = "${azurerm_container_registry.main.login_server}/brain-api:${var.image_tag}"
  agents_image = "${azurerm_container_registry.main.login_server}/brain-agents:${var.image_tag}"

  agents_fqdn = "${local.name_prefix}-agents.internal.${azurerm_container_app_environment.main.default_domain}"

  # Every Key Vault secret mounted into api/worker, keyed by the in-app secret
  # name (lowercase + hyphens, as Container Apps requires).
  kv_secret_refs = merge(
    {
      for role, env_name in local.db_role_urls :
      replace(lower(env_name), "_", "-") => azurerm_key_vault_secret.db_role_url[role].versionless_id
    },
    { for name, secret in azurerm_key_vault_secret.app_secret : name => secret.versionless_id },
    { for name, secret in azurerm_key_vault_secret.operator_supplied : name => secret.versionless_id },
    {
      "azure-blob-account-key" = azurerm_key_vault_secret.blob_account_key.versionless_id
      "redis-url"              = azurerm_key_vault_secret.redis_url.versionless_id
    },
  )

  # Auth service secrets -- intentionally a small subset, see the resource.
  auth_secret_env = {
    AUTH_SIGN_KEY           = "auth-sign-key"
    AUTH_COOKIE_SECRET      = "auth-cookie-secret"
    BRAIN_AUTH_DB_URL       = "brain-auth-db-url"
    BRAIN_RESOLVER_DB_URL   = "brain-resolver-db-url"
    BRAIN_AUTH_AUDIT_DB_URL = "brain-auth-audit-db-url"
    EMAIL_ENDPOINT          = "email-endpoint"
    EMAIL_API_KEY           = "email-api-key"
    EMAIL_FROM              = "email-from"
  }

  auth_kv_secrets = {
    for env_name, secret_name in local.auth_secret_env :
    secret_name => local.kv_secret_refs[secret_name]
  }

  # ENV_VAR => in-app secret name.
  #
  # BRAIN_SESSION_KEY and AUDIT_PUBLISHER_KEY are NOT here unconditionally.
  # Both are schema-validated as /^0x[0-9a-fA-F]{64}$/, so injecting the
  # placeholder value crashes the process at boot rather than leaving the
  # feature switched off. They are added only when their gate is on.
  secret_env = merge(
    { for role, env_name in local.db_role_urls : env_name => replace(lower(env_name), "_", "-") },
    {
      REDIS_URL                     = "redis-url"
      AUTH_COOKIE_SECRET            = "auth-cookie-secret"
      BRAIN_AGENTS_INBOUND_SECRET   = "brain-agents-inbound-secret"
      BRAIN_API_KEY_PEPPER          = "brain-api-key-pepper"
      BRAIN_DEMO_PROVISION_SECRET   = "brain-demo-provision-secret"
      BRAIN_SERVICE_TOKEN_SECRET    = "brain-service-token-secret"
      BRAIN_PLATFORM_SERVICE_SECRET = "brain-platform-service-secret"
      AUTH_SIGN_KEY                 = "auth-sign-key"
      AZURE_BLOB_ACCOUNT_KEY        = "azure-blob-account-key"
    },
    var.enable_onchain_signing ? { BRAIN_SESSION_KEY = "brain-session-key" } : {},
    var.enable_anchor_publisher ? { AUDIT_PUBLISHER_KEY = "audit-publisher-key" } : {},
  )

  auth_fqdn = "${local.name_prefix}-auth.internal.${azurerm_container_app_environment.main.default_domain}"

  # Plain (non-secret) configuration shared by api and worker.
  common_env = {
    NODE_ENV        = "production"
    BRAIN_ENV       = var.environment
    SERVICE_VERSION = var.service_version

    # Required by the config schema -- the api will not boot without it.
    AUTH_JWKS_URL = "https://${local.name_prefix}-auth.internal.${azurerm_container_app_environment.main.default_domain}/.well-known/jwks.json"
    AUTH_ISSUER   = var.auth_issuer

    # Raw layer on Azure Blob — MinIO does not exist in this topology.
    BLOB_BACKEND            = "azure"
    BLOB_CONTAINER          = azurerm_storage_container.raw_artifacts.name
    AZURE_BLOB_ACCOUNT_NAME = azurerm_storage_account.raw.name

    # Chain. Sepolia until ADR-0007's mainnet audit gate is cleared.
    BASE_RPC_URL                      = var.base_rpc_url
    BRAIN_ONCHAIN_SMART_ACCOUNT       = var.onchain_addresses.smart_account
    AUDIT_ANCHOR_ADDRESS              = var.onchain_addresses.audit_anchor
    POLICY_REGISTRY_ADDRESS           = var.onchain_addresses.policy_registry
    MCP_AGENT_REGISTRY_ADDRESS        = var.onchain_addresses.agent_registry
    BRAIN_REPUTATION_REGISTRY_ADDRESS = var.onchain_addresses.reputation_registry

    # Guarded by a validation rule in variables.tf — a short interval drains the
    # publisher key.
    AUDIT_ANCHOR_INTERVAL_MS = tostring(var.audit_anchor_interval_ms)

    # Escrow rail. Together with BRAIN_ONCHAIN_SMART_ACCOUNT this satisfies
    # rails-prod-fence, which refuses to boot in production unless at least one
    # live payment rail is configured. It is the only rail that needs no
    # private key, so the stack can run before the signing key is provisioned.
    BRAIN_ESCROW_ADDRESS = var.onchain_addresses.escrow

    # Required by the escrow rail's state loader: assertEscrowRailHasStateLoader
    # refuses to boot when the escrow rail is registered without it. It binds
    # the escrow's token to the settlement asset, which is what makes §6 gate
    # check 6.6 run -- unset, the rail still dispatches but 6.6 stays dormant.
    BRAIN_X402_USDC_ADDRESS = var.onchain_addresses.usdc

    AUDIT_ANCHOR_FROM_BLOCK      = tostring(var.audit_anchor_from_block)
    BRAIN_ONCHAIN_POLICY_VERSION = var.onchain_policy_version

    # Gas floors -- see the variable docs; these are a deliberate cost setting.
    BRAIN_ONCHAIN_MIN_MAX_FEE_GWEI      = var.onchain_min_max_fee_gwei
    BRAIN_ONCHAIN_MIN_PRIORITY_FEE_GWEI = var.onchain_min_priority_fee_gwei

    AUTH_AUDIENCE                       = "brain-api"
    BRAIN_AGENT_WINDOW_LOOKBACK_SECONDS = "86400"
    WIKI_EMBED_MODEL                    = "text-embedding-3-small"
    WIKI_LLM_MODEL                      = "gpt-4o-mini"

    BRAIN_SERVICE_TOKEN_ENABLED  = tostring(var.enable_service_token)
    BRAIN_DEMO_PROVISION_ENABLED = tostring(var.enable_demo_provision)
    # Attestations that this is a testnet deployment. Both features fence on
    # them in production; they are only meaningful while chain is Sepolia.
    BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED  = tostring(var.enable_service_token)
    BRAIN_DEMO_PROVISION_TESTNET_ATTESTED = tostring(var.enable_demo_provision)
  }
}

# ---------------------------------------------------------------------------
# API — HTTP only, no worker lanes (blocker #3: port is 3000, not 8080)
# ---------------------------------------------------------------------------
resource "azurerm_container_app" "api" {
  name                         = "${local.name_prefix}-api"
  resource_group_name          = azurerm_resource_group.primary.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
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

  dynamic "secret" {
    for_each = local.kv_secret_refs
    content {
      name                = secret.key
      identity            = azurerm_user_assigned_identity.services.id
      key_vault_secret_id = secret.value
    }
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = var.api_max_replicas

    container {
      name   = "api"
      image  = local.api_image
      cpu    = var.container_cpu
      memory = var.container_memory

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      env {
        name  = "SERVICE_NAME"
        value = "brain-api"
      }
      env {
        name  = "BRAIN_HTTP_ENABLED"
        value = "true"
      }
      # Workers run in the dedicated worker app below.
      env {
        name  = "BRAIN_WORKERS"
        value = "none"
      }

      dynamic "env" {
        for_each = local.deploys_agents ? [1] : []
        content {
          name  = "DOCUMENT_EXTRACT_AGENT_URL"
          value = "https://${local.agents_fqdn}"
        }
      }

      liveness_probe {
        transport = "HTTP"
        port      = 3000
        path      = "/health"
      }

      readiness_probe {
        transport = "HTTP"
        port      = 3000
        path      = "/health"
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# ---------------------------------------------------------------------------
# Worker — all background lanes, no HTTP (blocker #4)
#
# Since v0.0.6 the audit anchor publisher runs ONLY here. An API-only deployment
# serves traffic while silently never anchoring anything.
#
# max_replicas = 1 is deliberate: the anchor publisher is not safe to run
# concurrently. Two replicas race to publish the same root, and the loser burns
# gas reverting with RootAlreadyPublished — the failure mode recorded in
# `anchor-publisher-revert-fix`.
# ---------------------------------------------------------------------------
resource "azurerm_container_app" "worker" {
  name                         = "${local.name_prefix}-worker"
  resource_group_name          = azurerm_resource_group.primary.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.services.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.services.id
  }

  dynamic "secret" {
    for_each = local.kv_secret_refs
    content {
      name                = secret.key
      identity            = azurerm_user_assigned_identity.services.id
      key_vault_secret_id = secret.value
    }
  }

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "worker"
      image  = local.api_image
      cpu    = var.container_cpu
      memory = var.container_memory

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      env {
        name  = "SERVICE_NAME"
        value = "brain-worker"
      }
      env {
        name  = "BRAIN_HTTP_ENABLED"
        value = "false"
      }
      env {
        name  = "BRAIN_WORKERS"
        value = "all"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Agents (Python) — internal ingress only
# ---------------------------------------------------------------------------
resource "azurerm_container_app" "agents" {
  count                        = local.deploys_agents ? 1 : 0
  name                         = "${local.name_prefix}-agents"
  resource_group_name          = azurerm_resource_group.primary.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.services.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.services.id
  }

  secret {
    name                = "openai-api-key"
    identity            = azurerm_user_assigned_identity.services.id
    key_vault_secret_id = azurerm_key_vault_secret.operator_supplied["openai-api-key"].versionless_id
  }

  secret {
    name                = "brain-api-token"
    identity            = azurerm_user_assigned_identity.services.id
    key_vault_secret_id = azurerm_key_vault_secret.operator_supplied["brain-api-token"].versionless_id
  }

  secret {
    name                = "brain-agents-inbound-secret"
    identity            = azurerm_user_assigned_identity.services.id
    key_vault_secret_id = azurerm_key_vault_secret.app_secret["brain-agents-inbound-secret"].versionless_id
  }

  template {
    min_replicas = 1
    max_replicas = 3

    container {
      name   = "agents"
      image  = local.agents_image
      cpu    = 0.5
      memory = "1.0Gi"

      env {
        name  = "BRAIN_ENV"
        value = var.environment
      }
      env {
        name  = "SERVICE_NAME"
        value = "brain-agents"
      }
      # Same-environment call. Uses the API's own ingress FQDN rather than
      # api.brain.fi so agents keep working before the DNS cutover.
      env {
        name  = "BRAIN_API_BASE_URL"
        value = "https://${azurerm_container_app.api.ingress[0].fqdn}/v1"
      }
      env {
        name        = "OPENAI_API_KEY"
        secret_name = "openai-api-key"
      }
      env {
        name        = "BRAIN_API_TOKEN"
        secret_name = "brain-api-token"
      }
      env {
        name        = "BRAIN_AGENTS_INBOUND_SECRET"
        secret_name = "brain-agents-inbound-secret"
      }
    }
  }

  ingress {
    external_enabled = false
    target_port      = 8001

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# ---------------------------------------------------------------------------
# Auth service -- OAuth AS + JWKS. Same image, different entrypoint.
#
# The api requires AUTH_JWKS_URL and will not boot without it; this is what
# serves it. External ingress because /login and /consent are browser-facing.
#
# ⚠️ Its secret surface is deliberately MINIMAL -- it does NOT get the shared
# `local.kv_secret_refs` set that api/worker mount. This mirrors the compose
# definition, which pointedly has no env_file: this is a public browser-facing
# origin, so no production secret reaches it beyond what is listed here.
#
# ⚠️ DATABASE_SSL is deliberately NOT set. The compose file sets it to
# "disable" because its Postgres is an in-network container serving no TLS.
# Azure Flexible Server REQUIRES TLS, so copying that value here would silently
# kill every DB-backed route (login, token, register) while /healthz and JWKS
# kept returning 200 -- exactly the failure recorded in
# `auth-brain-fi-live-dcr-broken-2026-08-03`. Unset means pool.ts's "auto",
# which enables TLS for any non-localhost host.
# ---------------------------------------------------------------------------
resource "azurerm_container_app" "auth" {
  name                         = "${local.name_prefix}-auth"
  resource_group_name          = azurerm_resource_group.primary.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.services.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.services.id
  }

  dynamic "secret" {
    for_each = local.auth_kv_secrets
    content {
      name                = secret.key
      identity            = azurerm_user_assigned_identity.services.id
      key_vault_secret_id = secret.value
    }
  }

  template {
    min_replicas = 1
    max_replicas = 2

    container {
      name    = "auth"
      image   = local.api_image
      cpu     = 0.5
      memory  = "1.0Gi"
      command = ["node", "services/auth/dist/main.js"]

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "SERVICE_NAME"
        value = "brain-auth"
      }
      env {
        name  = "SERVICE_VERSION"
        value = var.service_version
      }
      env {
        name  = "AUTH_ISSUER"
        value = var.auth_issuer
      }
      env {
        name  = "AUTH_JWKS_URL"
        value = "https://${local.name_prefix}-auth.internal.${azurerm_container_app_environment.main.default_domain}/.well-known/jwks.json"
      }

      # Placeholders: loadConfig() requires these to parse as URLs, but this
      # service dials neither. Real DB access goes through the three
      # least-privilege role URLs below. localhost keeps pool.ts's ssl="auto"
      # from enabling TLS against a connection that is never opened.
      env {
        name  = "DATABASE_URL"
        value = "postgres://unused:unused@localhost:5432/unused"
      }
      env {
        name  = "REDIS_URL"
        value = "redis://localhost:6379"
      }

      dynamic "env" {
        for_each = local.auth_secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}

# ---------------------------------------------------------------------------
# One-shot jobs (blocker #5)
#
# ORDER IS LOAD-BEARING: migrate MUST run before db-roles. db-roles.sql grants
# by looping over tables that already exist, so running it first silently leaves
# the canonical/ledger projector roles without grants — the class of failure
# recorded in `brain-core-azure-live-deploy` (42501 every ~10s in production).
#
# Terraform can only order CREATION, not EXECUTION. Both are manual-trigger jobs
# and the runbook invokes them in sequence.
# ---------------------------------------------------------------------------
resource "azurerm_container_app_job" "migrate" {
  name                         = "${local.name_prefix}-migrate"
  resource_group_name          = azurerm_resource_group.primary.name
  location                     = azurerm_resource_group.primary.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 1800
  replica_retry_limit          = 0
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.services.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.services.id
  }

  secret {
    name                = "database-url"
    identity            = azurerm_user_assigned_identity.services.id
    key_vault_secret_id = azurerm_key_vault_secret.database_url_admin.versionless_id
  }

  template {
    container {
      name    = "migrate"
      image   = local.api_image
      cpu     = 0.5
      memory  = "1.0Gi"
      command = ["node", "tools/migrate/dist/cli.js", "up"]

      # DATABASE_SSL is deliberately unset: pool.ts defaults to ssl="auto",
      # which enables TLS for any non-localhost host. Setting it to "disable"
      # here would silently drop TLS to a managed Postgres.
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
    }
  }
}

# One-off bootstrap for managed Postgres, declared rather than run as an
# `az containerapp job start --image --command` override.
#
# The override form REPLACES the whole container spec, silently dropping every
# env var and secret -- which is exactly how the first attempt failed (psql fell
# back to a local socket with no PGHOST). Declaring it keeps the env attached
# and makes the step reproducible for the next environment.
#
# Idempotent: the script asserts pgcrypto is in `public` and inserts the
# brain_migrations row ON CONFLICT DO NOTHING. Safe to run on an already-
# bootstrapped database. MUST run BEFORE migrate on a fresh Azure database --
# see infra/baseline-0049.sh for why the migration cannot apply there.
resource "azurerm_container_app_job" "baseline" {
  name                         = "${local.name_prefix}-baseline"
  resource_group_name          = azurerm_resource_group.primary.name
  location                     = azurerm_resource_group.primary.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 0
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.services.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.services.id
  }

  secret {
    name                = "pg-admin-password"
    identity            = azurerm_user_assigned_identity.services.id
    key_vault_secret_id = azurerm_key_vault_secret.pg_admin.versionless_id
  }

  template {
    container {
      name    = "baseline"
      image   = "${azurerm_container_registry.main.login_server}/brain-db-roles:${var.image_tag}"
      cpu     = 0.5
      memory  = "1.0Gi"
      command = ["/baseline-0049.sh"]

      env {
        name  = "PGHOST"
        value = azurerm_postgresql_flexible_server.main.fqdn
      }
      env {
        name  = "PGUSER"
        value = azurerm_postgresql_flexible_server.main.administrator_login
      }
      env {
        name  = "PGDATABASE"
        value = azurerm_postgresql_flexible_server_database.brain.name
      }
      env {
        name  = "PGSSLMODE"
        value = "require"
      }
      env {
        name        = "PGPASSWORD"
        secret_name = "pg-admin-password"
      }
    }
  }
}

resource "azurerm_container_app_job" "db_roles" {
  name                         = "${local.name_prefix}-db-roles"
  resource_group_name          = azurerm_resource_group.primary.name
  location                     = azurerm_resource_group.primary.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 900
  replica_retry_limit          = 0
  tags                         = local.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.services.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.services.id
  }

  secret {
    name                = "pg-admin-password"
    identity            = azurerm_user_assigned_identity.services.id
    key_vault_secret_id = azurerm_key_vault_secret.pg_admin.versionless_id
  }

  dynamic "secret" {
    for_each = azurerm_key_vault_secret.db_role_password
    content {
      name                = secret.value.name
      identity            = azurerm_user_assigned_identity.services.id
      key_vault_secret_id = secret.value.versionless_id
    }
  }

  template {
    container {
      name   = "db-roles"
      image  = "${azurerm_container_registry.main.login_server}/brain-db-roles:${var.image_tag}"
      cpu    = 0.5
      memory = "1.0Gi"

      env {
        name  = "PGHOST"
        value = azurerm_postgresql_flexible_server.main.fqdn
      }
      env {
        name  = "PGUSER"
        value = azurerm_postgresql_flexible_server.main.administrator_login
      }
      env {
        name  = "PGDATABASE"
        value = azurerm_postgresql_flexible_server_database.brain.name
      }
      env {
        name  = "PGSSLMODE"
        value = "require"
      }
      env {
        name        = "PGPASSWORD"
        secret_name = "pg-admin-password"
      }

      # One env var per role password, named after the psql var db-roles.sql
      # expects. The image entrypoint turns these into `-v name=value` args.
      dynamic "env" {
        for_each = local.db_role_psql_var
        content {
          name        = upper(env.value)
          secret_name = "db-password-${replace(env.key, "_", "-")}"
        }
      }
    }
  }
}

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
  value = azurerm_managed_redis.main.hostname
}
output "api_fqdn" {
  description = "Public HTTPS endpoint of the API before any DNS cutover."
  value       = azurerm_container_app.api.ingress[0].fqdn
}
