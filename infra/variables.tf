variable "environment" {
  description = "Deployment environment: staging or production."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be one of: staging, production."
  }
}

variable "primary_location" {
  description = "Primary Azure region."
  type        = string
  default     = "eastus"
}

variable "backup_location" {
  description = "Backup Azure region for cross-region replication."
  type        = string
  default     = "westus3"
}

variable "services" {
  description = "Set of service names to deploy as Container Apps. Override in tfvars to deploy a subset (e.g. POC = [\"api\"])."
  type        = set(string)
  default     = ["api", "raw", "wiki", "policy", "execution", "audit", "agents"]
}

variable "openai_api_key_secret_name" {
  description = "Azure Key Vault secret name for the OpenAI API key used by the agents service."
  type        = string
  default     = "openai-api-key"
}

variable "brain_agents_inbound_secret_name" {
  description = "Azure Key Vault secret name for the API to agents HMAC secret."
  type        = string
  default     = "brain-agents-inbound-secret"
}

variable "brain_api_token_secret_name" {
  description = "Azure Key Vault secret name for the agents service outbound Brain API token."
  type        = string
  default     = "brain-api-token"
}
