locals {
  tags = {
    service     = "brain"
    environment = "staging"
    purpose     = "migration-rehearsal-route"
    managed_by  = "terraform"
    owner       = var.route_owner
    expires_at  = var.route_expires_at
    github_run  = var.github_run_id
  }
}

data "azurerm_private_dns_zone" "blob" {
  name                = var.staging_blob_private_dns_zone_name
  resource_group_name = var.staging_resource_group_name
}

data "azurerm_virtual_network" "source" {
  provider            = azurerm.source
  name                = var.source_vnet_name
  resource_group_name = var.source_resource_group_name
}

data "azurerm_subnet" "source_private_endpoint" {
  provider             = azurerm.source
  name                 = var.source_private_endpoint_subnet_name
  virtual_network_name = data.azurerm_virtual_network.source.name
  resource_group_name  = var.source_resource_group_name
}

resource "terraform_data" "dns_gate" {
  input = var.source_uses_azure_provided_dns

  lifecycle {
    precondition {
      condition     = var.source_uses_azure_provided_dns
      error_message = "The source VNet uses custom DNS. Stop until its private-zone forwarding is separately designed and reviewed."
    }
  }
}

# A source-VNet private endpoint exposes only this Blob account. It avoids the
# broader network reachability that VNet peering would create between the live
# VM network and the staging rehearsal network.
resource "azurerm_private_endpoint" "source_migration_blob" {
  provider            = azurerm.source
  name                = "brain-source-staging-migration-blob-pe"
  resource_group_name = var.source_resource_group_name
  location            = data.azurerm_virtual_network.source.location
  subnet_id           = data.azurerm_subnet.source_private_endpoint.id
  tags                = local.tags

  private_service_connection {
    name                           = "brain-source-staging-migration-blob-psc"
    private_connection_resource_id = var.migration_storage_account_id
    subresource_names              = ["blob"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "blob"
    private_dns_zone_ids = [data.azurerm_private_dns_zone.blob.id]
  }

  depends_on = [terraform_data.dns_gate]
}

# With Azure-provided DNS, linking the private zone directly to the source VNet
# makes the normal Blob hostname resolve to the source-VNet private endpoint. A
# custom DNS VNet is deliberately blocked above rather than silently falling
# back to a public endpoint.
resource "azurerm_private_dns_zone_virtual_network_link" "source_blob" {
  name                  = "brain-source-staging-migration-blob-link"
  resource_group_name   = var.staging_resource_group_name
  private_dns_zone_name = data.azurerm_private_dns_zone.blob.name
  virtual_network_id    = data.azurerm_virtual_network.source.id
  registration_enabled  = false
  tags                  = local.tags

  depends_on = [azurerm_private_endpoint.source_migration_blob]
}
