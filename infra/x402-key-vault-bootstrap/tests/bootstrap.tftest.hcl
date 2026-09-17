mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      subscription_id = "861547ad-b8ea-4f52-a51e-0638a4d4d446"
      tenant_id       = "11111111-2222-3333-4444-555555555555"
      object_id       = "66666666-7777-8888-9999-000000000000"
    }
  }
}

mock_provider "azapi" {}

variables {
  subscription_id      = "861547ad-b8ea-4f52-a51e-0638a4d4d446"
  tenant_id            = "11111111-2222-3333-4444-555555555555"
  treasury_alert_email = "treasury@brain.invalid"
  security_alert_email = "security@brain.invalid"
  github_run_id        = "123456"
}

run "premium_private_testnet_boundary" {
  command = plan

  assert {
    condition     = azurerm_key_vault.source.sku_name == "premium"
    error_message = "The source vault must use Key Vault Premium."
  }

  assert {
    condition     = azurerm_key_vault.source.public_network_access_enabled == false
    error_message = "The source vault must reject public network access."
  }

  assert {
    condition     = azurerm_key_vault.source.soft_delete_retention_days == 90
    error_message = "The source vault must retain soft-deleted material for 90 days."
  }

  assert {
    condition     = var.chain_id == 84532
    error_message = "The Premium-vault bootstrap must remain on Base Sepolia."
  }
}

run "mainnet_rejected" {
  command = plan

  variables {
    chain_id = 8453
  }

  expect_failures = [var.chain_id]
}
