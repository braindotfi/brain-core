# ---------------------------------------------------------------------------
# Key Vault secret surface (blocker #6)
#
# The scaffold wired three secrets. The runtime needs the full set below:
#   - 16 least-privilege Postgres role passwords consumed by infra/db-roles.sql
#   - 15 role connection URLs consumed by the app (DATABASE_URL + 14 BRAIN_*_DB_URL)
#   - generated application secrets (HMAC / pepper / cookie)
#   - operator-supplied secrets that must NEVER be machine-generated
#
# Operator-supplied secrets are created here with a placeholder value and
# `ignore_changes = [value]`, so the real value is set out-of-band (az keyvault
# secret set) and Terraform will not revert it. This deliberately replaces the
# scaffold's `data "azurerm_key_vault_secret"` lookups, which could not work:
# they required the secrets to already exist inside a vault that Terraform had
# not created yet.
# ---------------------------------------------------------------------------

locals {
  # role name in db-roles.sql => env var the app reads that role's URL from.
  db_role_urls = {
    brain_app                  = "DATABASE_URL"
    brain_wiki_reader          = "BRAIN_WIKI_DB_URL"
    brain_mcp_reader           = "BRAIN_MCP_READER_DB_URL"
    brain_raw_worker           = "BRAIN_RAW_WORKER_DB_URL"
    brain_canonical_projector  = "BRAIN_CANONICAL_PROJECTOR_DB_URL"
    brain_ledger_projector     = "BRAIN_LEDGER_PROJECTOR_DB_URL"
    brain_execution_worker     = "BRAIN_EXECUTION_WORKER_DB_URL"
    brain_audit_verifier       = "BRAIN_AUDIT_VERIFIER_DB_URL"
    brain_audit_publisher      = "BRAIN_AUDIT_PUBLISHER_DB_URL"
    brain_resolver             = "BRAIN_RESOLVER_DB_URL"
    brain_tenant_deletion      = "BRAIN_TENANT_DELETION_DB_URL"
    brain_surface_gateway      = "BRAIN_SURFACE_GATEWAY_DB_URL"
    brain_surface_audit_writer = "BRAIN_SURFACE_GATEWAY_AUDIT_DB_URL"
    brain_auth                 = "BRAIN_AUTH_DB_URL"
    brain_auth_audit_writer    = "BRAIN_AUTH_AUDIT_DB_URL"
  }

  # brain_privileged is granted BYPASSRLS and is used through a pool that is not
  # configured by URL, but db-roles.sql still needs its password.
  db_roles_password_only = ["brain_privileged"]

  db_roles_all = concat(keys(local.db_role_urls), local.db_roles_password_only)

  # psql var name in db-roles.sql for each role: brain_app => brain_app_password.
  # brain_wiki_reader is the one role whose var drops the `_reader` suffix.
  db_role_psql_var = {
    for role in local.db_roles_all :
    role => role == "brain_wiki_reader" ? "brain_wiki_reader_password" : "${role}_password"
  }
}

# ---------------------------------------------------------------------------
# Generated Postgres role passwords
#
# special = false is REQUIRED, not cosmetic: these are interpolated into
# postgres:// URLs, and random_password's default special set includes @ : / ?
# which silently corrupt a connection string. 40 alphanumeric chars is ample.
# ---------------------------------------------------------------------------

resource "random_password" "db_role" {
  for_each = toset(local.db_roles_all)
  length   = 40
  special  = false
}

resource "azurerm_key_vault_secret" "db_role_password" {
  for_each     = random_password.db_role
  name         = "db-password-${replace(each.key, "_", "-")}"
  value        = each.value.result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.operator_kv_admin]
}

resource "azurerm_key_vault_secret" "db_role_url" {
  for_each     = local.db_role_urls
  name         = replace(lower(each.value), "_", "-")
  value        = "postgres://${each.key}:${random_password.db_role[each.key].result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/brain?sslmode=require"
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.operator_kv_admin]
}

# ---------------------------------------------------------------------------
# Generated application secrets
# ---------------------------------------------------------------------------

locals {
  generated_app_secrets = [
    "auth-cookie-secret",
    "brain-agents-inbound-secret",
    "brain-api-key-pepper",
    "brain-demo-provision-secret",
    "brain-service-token-secret",
    "brain-platform-service-secret",
  ]
}

resource "random_password" "app_secret" {
  for_each = toset(local.generated_app_secrets)
  length   = 48
  special  = false
}

resource "azurerm_key_vault_secret" "app_secret" {
  for_each     = random_password.app_secret
  name         = each.key
  value        = each.value.result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.operator_kv_admin]
}

# ---------------------------------------------------------------------------
# Operator-supplied secrets -- placeholders, never generated
#
# AUTH_SIGN_KEY is a structured JWK; AUDIT_PUBLISHER_KEY and BRAIN_SESSION_KEY
# are EVM private keys that CONTROL REAL FUNDS. Generating them here would mint
# keys nobody has custody of and would silently break every issued token.
# Set them with:
#   az keyvault secret set --vault-name <kv> --name auth-sign-key --value @file
# ---------------------------------------------------------------------------

locals {
  operator_supplied_secrets = [
    "auth-sign-key",       # AUTH_SIGN_KEY -- JWK, must match issued tokens
    "audit-publisher-key", # AUDIT_PUBLISHER_KEY -- funded EVM key
    "brain-session-key",   # BRAIN_SESSION_KEY -- funded EVM key
    "openai-api-key",      # external credential
    "brain-api-token",     # agents -> API bearer token
    "terraform-client-secret", # in-VNet runner auth; see the runner job
    "email-endpoint",      # auth service hard-exits without these two
    "email-api-key",
    "email-from",
  ]
}

resource "azurerm_key_vault_secret" "operator_supplied" {
  for_each     = toset(local.operator_supplied_secrets)
  name         = each.key
  value        = "PLACEHOLDER-SET-OUT-OF-BAND"
  key_vault_id = azurerm_key_vault.main.id

  # The operator sets the real value; Terraform must not revert it.
  lifecycle {
    ignore_changes = [value]
  }

  depends_on = [azurerm_role_assignment.operator_kv_admin]
}

# ---------------------------------------------------------------------------
# Storage account key (AZURE_BLOB_ACCOUNT_KEY)
# ---------------------------------------------------------------------------

# Admin connection string, for the migrate job ONLY.
#
# Migrations must NOT run as brain_app: that role is created BY db-roles.sql,
# which itself must run after migrate (its grants only see tables that already
# exist). Pointing migrate at brain_app is a deadlock -- the role it
# authenticates as cannot exist until a step that depends on migrate has run.
# The server administrator is the only principal available at that point.
resource "azurerm_key_vault_secret" "database_url_admin" {
  name         = "database-url-admin"
  value        = "postgres://${azurerm_postgresql_flexible_server.main.administrator_login}:${random_password.pg_admin.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${azurerm_postgresql_flexible_server_database.brain.name}?sslmode=require"
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.operator_kv_admin]
}

resource "azurerm_key_vault_secret" "blob_account_key" {
  name         = "azure-blob-account-key"
  value        = azurerm_storage_account.raw.primary_access_key
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.operator_kv_admin]
}

# ---------------------------------------------------------------------------
# Source-credential encryption key (BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME)
#
# The app authenticates to Key Vault itself via its managed identity and
# fetches this secret by name -- it is not mounted as a Container Apps secret
# like the ones above. See the comment on BRAIN_SOURCE_CREDENTIAL_KEY_VAULT_NAME
# in main.tf's common_env for why.
# ---------------------------------------------------------------------------

resource "random_bytes" "source_credential_key" {
  length = 32
}

resource "azurerm_key_vault_secret" "source_credential_key" {
  name         = "source-credential-key"
  value        = random_bytes.source_credential_key.base64
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.operator_kv_admin]
}

# ---------------------------------------------------------------------------
# Convenience: the exact `psql -v` arguments the db-roles job must pass.
# Consumed by the db-roles Container App Job in main.tf.
# ---------------------------------------------------------------------------

output "db_roles_psql_vars" {
  description = "psql variable names db-roles.sql expects, mapped to their Key Vault secret names."
  value = {
    for role in local.db_roles_all :
    local.db_role_psql_var[role] => "db-password-${replace(role, "_", "-")}"
  }
}
