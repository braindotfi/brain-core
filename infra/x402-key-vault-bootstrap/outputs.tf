output "custody_checkpoint" {
  description = "Non-secret evidence used by the ceremony and runtime configuration."
  value = {
    chain_id                   = var.chain_id
    vault_uri                  = azurerm_key_vault.source.vault_uri
    restore_vault_uri          = azurerm_key_vault.restore_drill.vault_uri
    seller_key_versioned_uri   = azapi_resource.seller_key.output.properties.keyUriWithVersion
    signer_client_id           = azurerm_user_assigned_identity.signer.client_id
    signer_principal_id        = azurerm_user_assigned_identity.signer.principal_id
    signer_role_scope          = azurerm_role_assignment.signer.scope
    address_classification_tag = "x402_sepolia_bootstrap_only"
    payments_enabled           = false
  }
}
