# Terraform providers and version constraints.
# Full resource definitions land in stage-8 per Brain_Claude_Code_Prompt.docx.

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

  # Remote state wired in stage-8. Using local backend during scaffolding only.
  # backend "azurerm" {
  #   resource_group_name  = "brain-tfstate"
  #   storage_account_name = "braintfstate"
  #   container_name       = "tfstate"
  #   key                  = "prod.terraform.tfstate"
  # }
}

provider "azurerm" {
  features {}
}

provider "azuread" {}
