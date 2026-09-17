variable "subscription_id" {
  description = "Approved Azure production subscription UUID."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.subscription_id))
    error_message = "subscription_id must be an Azure subscription UUID."
  }
}

variable "tenant_id" {
  description = "Microsoft Entra tenant UUID for the production subscription."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.tenant_id))
    error_message = "tenant_id must be a Microsoft Entra tenant UUID."
  }
}

variable "location" {
  description = "Approved geography for both the source and restore-drill vaults."
  type        = string
  default     = "canadacentral"

  validation {
    condition     = var.location == "canadacentral"
    error_message = "The x402 bootstrap location is fixed to canadacentral."
  }
}

variable "resource_group_name" {
  description = "Dedicated resource group for the x402 Sepolia custody bootstrap."
  type        = string
  default     = "brain-x402-sepolia-custody-rg"

  validation {
    condition     = var.resource_group_name == "brain-x402-sepolia-custody-rg"
    error_message = "The x402 bootstrap resource group name is fixed."
  }
}

variable "vault_name" {
  description = "Premium source vault containing the Base Sepolia seller key."
  type        = string
  default     = "brain-x402-sepolia-kv"

  validation {
    condition     = var.vault_name == "brain-x402-sepolia-kv"
    error_message = "The x402 source vault name is fixed."
  }
}

variable "restore_vault_name" {
  description = "Isolated Premium vault used only for the witnessed restore drill."
  type        = string
  default     = "brain-x402-restore-kv"

  validation {
    condition     = var.restore_vault_name == "brain-x402-restore-kv"
    error_message = "The x402 restore-drill vault name is fixed."
  }
}

variable "treasury_alert_email" {
  description = "Damon's monitored Treasury alert address."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+$", var.treasury_alert_email))
    error_message = "treasury_alert_email must be an email address."
  }
}

variable "security_alert_email" {
  description = "Sanket's monitored Security alert address."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+$", var.security_alert_email))
    error_message = "security_alert_email must be an email address."
  }
}

variable "chain_id" {
  description = "Only Base Sepolia is permitted for the Premium-vault bootstrap."
  type        = number
  default     = 84532

  validation {
    condition     = var.chain_id == 84532
    error_message = "A Key Vault Premium x402 key is permitted only on Base Sepolia chain 84532."
  }
}

variable "github_run_id" {
  description = "GitHub Actions run that produced the reviewed apply."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_run_id))
    error_message = "github_run_id must contain digits only."
  }
}
