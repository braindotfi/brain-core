terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.3"
    }
  }

  backend "azurerm" {}
}

provider "azurerm" {
  subscription_id = var.staging_subscription_id
  features {}
}

provider "azurerm" {
  alias           = "source"
  subscription_id = var.source_subscription_id
  features {}
}
