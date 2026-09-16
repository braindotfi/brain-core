import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const terraform = readFileSync(resolve(root, "infra/x402-hsm.tf"), "utf8");
const providers = readFileSync(resolve(root, "infra/versions.tf"), "utf8");
const tfvars = readFileSync(resolve(root, "infra/production.tfvars"), "utf8");
const contract = readFileSync(resolve(root, "docs/contracts/x402-seller-phase2.md"), "utf8");
const roles = readFileSync(resolve(root, "infra/db-roles.sql"), "utf8");

describe("x402 Phase 2 custody structure", () => {
  it("creates a private purge-protected HSM and non-exportable P-256K sign key", () => {
    expect(terraform).toContain("public_network_access_enabled = false");
    expect(terraform).toContain("purge_protection_enabled      = true");
    expect(terraform).toContain('key_type       = "EC-HSM"');
    expect(terraform).toContain('curve          = "P-256K"');
    expect(terraform).toContain('key_opts       = ["sign"]');
    expect(terraform).toContain("prevent_destroy = true");
  });

  it("grants the dedicated signer only sign on the one seller key", () => {
    expect(terraform).toContain('name                = "brain-x402-treasury-signer"');
    expect(terraform).toContain(
      'data_actions = ["Microsoft.KeyVault/managedHsm/keys/sign/action"]',
    );
    expect(terraform).toContain('scope              = "/keys/${');
    expect(terraform).not.toContain("keys/create");
    expect(terraform).not.toContain("keys/delete");
  });

  it("keeps immutable recovery evidence separate from backup-compatible storage", () => {
    expect(terraform).toContain('name                              = "brainx402recoveryprod"');
    expect(terraform).toContain('name                              = "brainx402backupprod"');
    expect(terraform).toContain('name                  = "managed-hsm-security-domain"');
    expect(terraform).toContain('name                  = "managed-hsm-full-backups"');
    expect(terraform).toMatch(/account_replication_type\s*=\s*"GRS"/);
    expect(terraform).toMatch(/infrastructure_encryption_enabled\s*=\s*true/);
    expect(terraform).toMatch(/versioning_enabled\s*=\s*true/);
    expect(terraform).toMatch(/immutability_period_in_days\s*=\s*2555/);
    expect(terraform).not.toContain(
      'azurerm_storage_container_immutability_policy" "x402_hsm_backup',
    );
  });

  it("makes the backup account private while allowing Azure's trusted backup service", () => {
    expect(terraform).toContain('resource "azurerm_private_endpoint" "x402_hsm_backup_blob"');
    expect(terraform).toContain('name                = "privatelink.blob.core.windows.net"');
    expect(terraform).toContain('subresource_names              = ["blob"]');
    expect(terraform).toContain('bypass         = ["AzureServices"]');
    expect(terraform).toContain("shared_access_key_enabled         = false");
    expect(terraform).toContain("public_network_access_enabled     = false");
  });

  it("gives the backup identity only destination storage and HSM backup access", () => {
    expect(terraform).toContain('name                = "brain-x402-hsm-backup"');
    expect(terraform).toContain('role_definition_name = "Storage Blob Data Contributor"');
    expect(terraform).toContain(
      "scope                = azurerm_storage_account.x402_hsm_backup[0].id",
    );
    expect(terraform).toContain('"Microsoft.KeyVault/managedHsm/backup/start/action"');
    expect(terraform).toContain('"Microsoft.KeyVault/managedHsm/backup/status/action"');
    expect(terraform).not.toContain("managedHsm/restore/start/action");
    expect(terraform).not.toContain("managedHsm/restore/status/action");
    expect(terraform).toContain('resource "azapi_update_resource" "x402_hsm_backup_identity"');
    expect(providers).toContain('source  = "Azure/azapi"');
  });

  it("pins the interim recovery model to Damon and Sanket with a mainnet hard gate", () => {
    expect(contract).toContain("Holder A: Damon");
    expect(contract).toContain("Holder B: Sanket");
    expect(contract).toContain("effective two-of-two recovery");
    expect(contract).toContain("transient C");
    expect(contract).toMatch(/at least three real and distinct\s+recovery holders/);
    expect(terraform).toContain("recovery_envelope_keys    = 3");
    expect(terraform).toContain("recovery_quorum           = 2");
    expect(terraform).toContain("retained_recovery_holders = 2");
  });

  it("stops the first apply before HSM activation and key creation", () => {
    expect(tfvars).toContain("enable_x402_phase2_custody = true");
    expect(tfvars).toContain("x402_hsm_activated         = false");
    expect(tfvars).toContain("enable_x402_payments       = false");
    expect(terraform).toContain("count          = var.x402_hsm_activated ? 1 : 0");
    expect(contract).toContain("reviewed ceremony-only Terraform");
    expect(contract).toMatch(/It does\s+not enable x402 payments/);
    expect(contract).toMatch(/ceremony then takes a full backup and must prove an A\+B recovery/);
  });

  it("isolates treasury controls behind a dedicated no-login operator", () => {
    expect(roles).toContain("CREATE ROLE brain_x402_treasury_operator NOLOGIN");
    expect(roles).toContain(
      "REVOKE ALL PRIVILEGES ON x402_seller_wallets, x402_sweep_destination_changes",
    );
    expect(roles).toContain("GRANT INSERT ON x402_seller_wallets, x402_sweep_destination_changes");
    expect(roles).toContain("'brain_app', 'public.x402_sweep_destination_changes', 'INSERT'");
    expect(roles).toContain(
      "'brain_x402_seller_worker', 'public.x402_sweep_destination_changes', 'INSERT'",
    );
  });
});
