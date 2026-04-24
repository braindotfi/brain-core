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
