# Terraform providers and version constraints.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.3"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state (blocker #7). The backing storage account is created by
  # infra/bootstrap, which keeps its own tiny local state -- a backend cannot
  # provision the storage it is stored in.
  #
  # Values are supplied at init time so the same config serves both
  # environments:
  #   terraform init -backend-config=backend-production.hcl
  backend "azurerm" {}
}

provider "azurerm" {
  features {
    key_vault {
      # Production secrets must survive a `terraform destroy` of the vault.
      # Purge protection is on, so a purge would fail anyway -- this makes the
      # intent explicit rather than relying on an API error.
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }

    resource_group {
      # Refuse to delete a resource group that still contains resources
      # Terraform does not know about.
      prevent_deletion_if_contains_resources = true
    }
  }
}

provider "azuread" {}
