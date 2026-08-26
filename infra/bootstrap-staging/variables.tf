variable "staging_subscription_id" {
  description = "Subscription containing only the approved staging rehearsal resources."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.staging_subscription_id))
    error_message = "staging_subscription_id must be an Azure subscription UUID."
  }
}

variable "staging_tenant_id" {
  description = "Microsoft Entra tenant containing the staging GitHub OIDC application."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.staging_tenant_id))
    error_message = "staging_tenant_id must be a Microsoft Entra tenant UUID."
  }
}

variable "location" {
  description = "Azure region for the staging state and workload resource groups."
  type        = string
  default     = "canadacentral"

  validation {
    condition     = var.location == "canadacentral"
    error_message = "The approved staging region is canadacentral."
  }
}

variable "state_resource_group_name" {
  description = "Dedicated resource group for staging Terraform state."
  type        = string
  default     = "brain-staging-tfstate-rg"

  validation {
    condition     = var.state_resource_group_name == "brain-staging-tfstate-rg"
    error_message = "The staging state resource group name is fixed by the isolation contract."
  }
}

variable "workload_resource_group_name" {
  description = "Empty staging workload boundary retained between rehearsals."
  type        = string
  default     = "brain-staging-rg"

  validation {
    condition     = var.workload_resource_group_name == "brain-staging-rg"
    error_message = "The staging workload resource group name is fixed by the isolation contract."
  }
}

variable "state_storage_account_name" {
  description = "Globally unique account containing only staging Terraform state."
  type        = string
  default     = "brainfitfstatestg"

  validation {
    condition     = can(regex("^brain[a-z0-9]{10,19}$", var.state_storage_account_name))
    error_message = "state_storage_account_name must be 15 to 24 lowercase alphanumeric characters beginning with brain."
  }
}

variable "state_container_name" {
  description = "Container containing staging Terraform state only."
  type        = string
  default     = "tfstate-staging"

  validation {
    condition     = var.state_container_name == "tfstate-staging"
    error_message = "The staging state container name is fixed by the isolation contract."
  }
}

variable "github_repository" {
  description = "GitHub repository allowed to exchange an OIDC token."
  type        = string
  default     = "braindotfi/brain-core"

  validation {
    condition     = var.github_repository == "braindotfi/brain-core"
    error_message = "The staging OIDC credential is restricted to braindotfi/brain-core."
  }
}

variable "github_environment" {
  description = "Protected GitHub environment bound into the OIDC subject."
  type        = string
  default     = "azure-staging-rehearsal"

  validation {
    condition     = var.github_environment == "azure-staging-rehearsal"
    error_message = "The staging OIDC credential must use azure-staging-rehearsal."
  }
}

variable "github_reviewer_user_ids" {
  description = "One to six GitHub numeric user IDs allowed to approve the protected staging environment."
  type        = set(number)

  validation {
    condition     = length(var.github_reviewer_user_ids) >= 1 && length(var.github_reviewer_user_ids) <= 6 && alltrue([for id in var.github_reviewer_user_ids : id > 0])
    error_message = "github_reviewer_user_ids must contain one to six positive GitHub user IDs."
  }
}

variable "production_subscription_id_deny" {
  description = "Production subscription UUID that staging workflows must reject."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.production_subscription_id_deny))
    error_message = "production_subscription_id_deny must be an Azure subscription UUID."
  }
}

variable "migration_operator_object_id" {
  description = "Microsoft Entra object ID allowed to write staging migration evidence."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.migration_operator_object_id))
    error_message = "migration_operator_object_id must be a Microsoft Entra object UUID."
  }
}

variable "independent_verifier_object_id" {
  description = "Distinct Microsoft Entra object ID allowed to verify staging migration evidence."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.independent_verifier_object_id))
    error_message = "independent_verifier_object_id must be a Microsoft Entra object UUID."
  }
}

variable "owner" {
  description = "Named owner of the staging bootstrap resources."
  type        = string

  validation {
    condition     = length(trimspace(var.owner)) >= 3
    error_message = "owner must name the person responsible for the bootstrap resources."
  }
}
