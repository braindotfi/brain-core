# ---------------------------------------------------------------------------
# Remote state bootstrap (blocker #7).
#
# Chicken-and-egg: the main stack stores its state in a storage account, so that
# account cannot itself be created by the main stack. This tiny config keeps a
# LOCAL state file (committed alongside it is fine -- it holds no secrets) and
# provisions only the state container.
#
# Run once:
#   cd infra/bootstrap && terraform init && terraform apply
#
# Then initialise the main stack against it:
#   cd infra && terraform init -backend-config=backend-production.hcl
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.3"
    }
  }
}

provider "azurerm" {
  features {}
}

variable "location" {
  description = "Region for the state account."
  type        = string
  default     = "canadacentral"
}

variable "state_storage_account_name" {
  description = "Globally unique storage account name for Terraform state."
  type        = string
  default     = "brainfitfstate"
}

resource "azurerm_resource_group" "tfstate" {
  name     = "brain-tfstate-rg"
  location = var.location
  tags = {
    service    = "brain"
    purpose    = "terraform-state"
    managed_by = "terraform"
  }
}

resource "azurerm_storage_account" "tfstate" {
  name                            = var.state_storage_account_name
  resource_group_name             = azurerm_resource_group.tfstate.name
  location                        = azurerm_resource_group.tfstate.location
  account_tier                    = "Standard"
  account_replication_type        = "ZRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false

  # State files are the only record of what exists. Versioning plus a delete
  # retention window makes a corrupted or truncated state recoverable.
  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = 30
    }

    container_delete_retention_policy {
      days = 30
    }
  }

  tags = azurerm_resource_group.tfstate.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_storage_container" "tfstate" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.tfstate.id
  container_access_type = "private"
}

output "backend_config" {
  description = "Paste into infra/backend-<env>.hcl"
  value       = <<-EOT
    resource_group_name  = "${azurerm_resource_group.tfstate.name}"
    storage_account_name = "${azurerm_storage_account.tfstate.name}"
    container_name       = "${azurerm_storage_container.tfstate.name}"
    key                  = "production.terraform.tfstate"
  EOT
}

# ---------------------------------------------------------------------------
# State data-plane access.
#
# The backend uses `use_azuread_auth`, so identity -- not the account key --
# authorises reads and writes of the state blob. Subscription Contributor is a
# CONTROL-plane role and does not grant blob data access, so without this the
# main stack's `terraform init` fails with 403.
#
# Granted to whoever runs this bootstrap (the brain-terraform service
# principal). CI authenticates as the same principal, so it inherits this.
# ---------------------------------------------------------------------------
data "azurerm_client_config" "current" {}

resource "azurerm_role_assignment" "tfstate_blob" {
  scope                = azurerm_storage_account.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}
