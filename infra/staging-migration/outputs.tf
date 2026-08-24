output "migration_storage_account_name" {
  value = azurerm_storage_account.migration.name
}

output "migration_storage_account_id" {
  value = azurerm_storage_account.migration.id
}

output "migration_blob_private_endpoint_id" {
  value = azurerm_private_endpoint.migration_blob.id
}

output "migration_blob_private_dns_zone_id" {
  value = azurerm_private_dns_zone.blob.id
}

output "migration_wrapping_key_versionless_id" {
  value = azurerm_key_vault_key.migration_wrap.versionless_id
}

output "migration_prepare_job_name" {
  value = azurerm_container_app_job.prepare.name
}

output "migration_validate_job_name" {
  value = azurerm_container_app_job.validate.name
}

output "source_upload_auth_mode" {
  value = var.source_upload_auth_mode
}
