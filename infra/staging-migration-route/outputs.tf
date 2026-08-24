output "source_migration_blob_private_endpoint_id" {
  value = azurerm_private_endpoint.source_migration_blob.id
}

output "source_blob_private_dns_link_id" {
  value = azurerm_private_dns_zone_virtual_network_link.source_blob.id
}
