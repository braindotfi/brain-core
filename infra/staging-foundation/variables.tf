variable "staging_subscription_id" {
  description = "Shared Azure subscription containing the resource-group-isolated staging rehearsal resources."
  type        = string

  validation {
    condition     = lower(var.staging_subscription_id) == "861547ad-b8ea-4f52-a51e-0638a4d4d446"
    error_message = "staging_subscription_id must be the approved shared Azure subscription."
  }
}

variable "staging_tenant_id" {
  description = "Microsoft Entra tenant for the staging subscription."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.staging_tenant_id))
    error_message = "staging_tenant_id must be a Microsoft Entra tenant UUID."
  }
}

variable "location" {
  description = "Approved Azure region for the staging rehearsal."
  type        = string
  default     = "canadacentral"

  validation {
    condition     = var.location == "canadacentral"
    error_message = "The approved staging region is canadacentral."
  }
}

variable "resource_group_name" {
  description = "Pre-created staging workload resource group."
  type        = string
  default     = "brain-core-staging-api-rg"

  validation {
    condition     = var.resource_group_name == "brain-core-staging-api-rg"
    error_message = "The foundation may target only brain-core-staging-api-rg."
  }
}

variable "vnet_name" {
  description = "Staging-only virtual network name."
  type        = string
  default     = "brain-core-staging-vnet"

  validation {
    condition     = var.vnet_name == "brain-core-staging-vnet"
    error_message = "The foundation VNet name is fixed by the staging contract."
  }
}

variable "vnet_address_space" {
  description = "Non-overlapping staging VNet address space approved after Azure inventory."
  type        = string
  default     = "10.30.0.0/16"

  validation {
    condition     = can(cidrhost(var.vnet_address_space, 0)) && tonumber(split("/", var.vnet_address_space)[1]) <= 23
    error_message = "vnet_address_space must be a valid CIDR large enough for the Container Apps subnet."
  }
}

variable "key_vault_name" {
  description = "Globally unique staging Key Vault name."
  type        = string
  default     = "brain-core-staging-kv"

  validation {
    condition     = var.key_vault_name == "brain-core-staging-kv"
    error_message = "The staging Key Vault name is fixed by the reviewed contract."
  }
}

variable "container_app_environment_name" {
  description = "Staging Container Apps environment name."
  type        = string
  default     = "brain-core-staging-env"

  validation {
    condition     = var.container_app_environment_name == "brain-core-staging-env"
    error_message = "The staging Container Apps environment name is fixed by the reviewed contract."
  }
}

variable "acr_name" {
  description = "Globally unique staging Azure Container Registry name."
  type        = string
  default     = "braincorestagingacr"

  validation {
    condition     = var.acr_name == "braincorestagingacr"
    error_message = "The staging ACR name is fixed by the reviewed contract."
  }
}

variable "log_analytics_name" {
  description = "Staging-only Log Analytics workspace name."
  type        = string
  default     = "brain-core-staging-logs"

  validation {
    condition     = var.log_analytics_name == "brain-core-staging-logs"
    error_message = "The staging Log Analytics name is fixed by the reviewed contract."
  }
}

variable "log_retention_days" {
  description = "Staging Log Analytics retention period."
  type        = number
  default     = 30

  validation {
    condition     = var.log_retention_days == 30
    error_message = "Staging Log Analytics retention must remain 30 days."
  }
}

variable "migration_operator_object_id" {
  description = "Object ID allowed to write staging migration evidence secrets."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.migration_operator_object_id))
    error_message = "migration_operator_object_id must be a Microsoft Entra object UUID."
  }
}

variable "independent_verifier_object_id" {
  description = "Distinct object ID allowed to read staging migration evidence secrets."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.independent_verifier_object_id))
    error_message = "independent_verifier_object_id must be a Microsoft Entra object UUID."
  }
}

variable "rehearsal_owner" {
  description = "Named owner responsible for teardown."
  type        = string

  validation {
    condition     = length(trimspace(var.rehearsal_owner)) >= 3
    error_message = "rehearsal_owner must name the person responsible for teardown."
  }
}

variable "rehearsal_expires_at" {
  description = "Approved UTC expiry timestamp for the ephemeral foundation."
  type        = string

  validation {
    condition     = can(formatdate("YYYY-MM-DD'T'hh:mm:ssZ", var.rehearsal_expires_at))
    error_message = "rehearsal_expires_at must be an RFC 3339 timestamp."
  }
}

variable "github_run_id" {
  description = "GitHub Actions run ID owning the ephemeral foundation."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_run_id))
    error_message = "github_run_id must contain digits only."
  }
}
