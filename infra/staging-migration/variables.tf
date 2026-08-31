variable "staging_subscription_id" {
  description = "Shared Azure subscription containing the resource-group-isolated staging rehearsal resources."
  type        = string

  validation {
    condition     = lower(var.staging_subscription_id) == "861547ad-b8ea-4f52-a51e-0638a4d4d446"
    error_message = "staging_subscription_id must be the approved shared Azure subscription."
  }
}

variable "staging_resource_group_name" {
  description = "Existing PR #745 ephemeral workload resource group."
  type        = string
  default     = "brain-core-staging-api-rg"

  validation {
    condition     = startswith(var.staging_resource_group_name, "brain-core-staging-") && !strcontains(lower(var.staging_resource_group_name), "production")
    error_message = "staging_resource_group_name must be an isolated brain-core-staging resource group."
  }
}

variable "staging_key_vault_name" {
  description = "Existing ephemeral staging foundation Key Vault."
  type        = string
  default     = "brain-core-staging-kv"

  validation {
    condition     = startswith(var.staging_key_vault_name, "brain-core-staging-") && !strcontains(lower(var.staging_key_vault_name), "production")
    error_message = "staging_key_vault_name must identify the staging vault."
  }
}

variable "staging_vnet_name" {
  description = "Existing ephemeral PR #745 staging VNet."
  type        = string
  default     = "brain-core-staging-vnet"
}

variable "staging_private_endpoint_subnet_name" {
  description = "Existing staging subnet dedicated to private endpoints."
  type        = string
  default     = "snet-private-endpoints"
}

variable "staging_container_app_environment_name" {
  description = "Existing ephemeral PR #745 Container Apps environment."
  type        = string
  default     = "brain-core-staging-env"
}

variable "staging_acr_name" {
  description = "Existing ephemeral staging foundation container registry."
  type        = string
  default     = "braincorestagingacr"
}

variable "migration_storage_account_name" {
  description = "Globally unique ephemeral migration-intake storage account name."
  type        = string

  validation {
    condition     = can(regex("^braincorestgmig[a-z0-9]{3,9}$", var.migration_storage_account_name))
    error_message = "migration_storage_account_name must be 18 to 24 lowercase alphanumerics beginning with braincorestgmig."
  }
}

variable "migration_retention_days" {
  description = "Maximum age of migration ciphertext before Blob lifecycle deletion."
  type        = number
  default     = 7

  validation {
    condition     = var.migration_retention_days >= 1 && var.migration_retention_days <= 7
    error_message = "migration_retention_days must be between 1 and 7."
  }
}

variable "source_upload_auth_mode" {
  description = "Selected only after Task 1 inventory: managed_identity or user_delegation_sas."
  type        = string

  validation {
    condition     = contains(["managed_identity", "user_delegation_sas"], var.source_upload_auth_mode)
    error_message = "source_upload_auth_mode must be managed_identity or user_delegation_sas."
  }
}

variable "source_uploader_principal_id" {
  description = "Existing production VM managed-identity principal when source_upload_auth_mode is managed_identity."
  type        = string
  default     = null

  validation {
    condition     = var.source_upload_auth_mode != "managed_identity" || (var.source_uploader_principal_id != null && can(regex("^[0-9a-fA-F-]{36}$", var.source_uploader_principal_id)))
    error_message = "A managed-identity principal UUID is required after Task 1 confirms it is usable."
  }
}

variable "sas_issuer_principal_id" {
  description = "Sanket's approved Entra principal when the managed-identity path is unavailable."
  type        = string
  default     = null

  validation {
    condition     = var.source_upload_auth_mode != "user_delegation_sas" || (var.sas_issuer_principal_id != null && can(regex("^[0-9a-fA-F-]{36}$", var.sas_issuer_principal_id)))
    error_message = "An approved SAS issuer principal UUID is required for user_delegation_sas."
  }
}

variable "api_image" {
  description = "Immutable staging API image containing the reviewed migration intake tooling."
  type        = string

  validation {
    condition     = can(regex("^braincorestagingacr\\.azurecr\\.io/brain-api:[0-9a-f]{8}$", var.api_image))
    error_message = "api_image must be a SHA-tagged image in braincorestagingacr."
  }
}

variable "rehearsal_owner" {
  description = "Named owner responsible for cleanup."
  type        = string

  validation {
    condition     = length(trimspace(var.rehearsal_owner)) >= 3
    error_message = "rehearsal_owner must name the cleanup owner."
  }
}

variable "rehearsal_expires_at" {
  description = "Approved UTC expiry timestamp for the ephemeral workload."
  type        = string

  validation {
    condition     = can(formatdate("YYYY-MM-DD'T'hh:mm:ssZ", var.rehearsal_expires_at))
    error_message = "rehearsal_expires_at must be an RFC 3339 timestamp."
  }
}

variable "github_run_id" {
  description = "GitHub Actions run ID that owns this ephemeral stack."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_run_id))
    error_message = "github_run_id must contain digits only."
  }
}
