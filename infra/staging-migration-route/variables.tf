variable "staging_subscription_id" {
  description = "Subscription containing the isolated staging rehearsal VNet."
  type        = string
}

variable "source_subscription_id" {
  description = "Subscription containing the authoritative production VM VNet."
  type        = string
}

variable "staging_resource_group_name" {
  type    = string
  default = "brain-staging-rg"

  validation {
    condition     = startswith(var.staging_resource_group_name, "brain-staging-")
    error_message = "staging_resource_group_name must be staging-scoped."
  }
}

variable "source_resource_group_name" {
  description = "Resource group containing the production VM VNet confirmed by Task 1."
  type        = string
}

variable "source_vnet_name" {
  description = "Production VM VNet confirmed by Task 1."
  type        = string
}

variable "source_private_endpoint_subnet_name" {
  description = "Existing source-VNet subnet approved for the temporary Blob private endpoint."
  type        = string
}

variable "migration_storage_account_id" {
  description = "Exact staging migration storage account resource ID from the intake Terraform output."
  type        = string

  validation {
    condition     = startswith(lower(var.migration_storage_account_id), "/subscriptions/${lower(var.staging_subscription_id)}/") && strcontains(lower(var.migration_storage_account_id), "/storageaccounts/brainstgmig") && !strcontains(lower(var.migration_storage_account_id), "production")
    error_message = "migration_storage_account_id must be the staging brainstgmig account in the expected subscription."
  }
}

variable "staging_blob_private_dns_zone_name" {
  type    = string
  default = "privatelink.blob.core.windows.net"
}

variable "source_uses_azure_provided_dns" {
  description = "Must be confirmed by Task 1. Custom DNS requires a separately reviewed conditional forwarder."
  type        = bool
}

variable "route_owner" {
  description = "Named operator responsible for removing this temporary route."
  type        = string
}

variable "route_expires_at" {
  description = "Approved UTC expiry timestamp for the temporary peering."
  type        = string
}

variable "github_run_id" {
  description = "Approved rehearsal run that owns this temporary route."
  type        = string
}
