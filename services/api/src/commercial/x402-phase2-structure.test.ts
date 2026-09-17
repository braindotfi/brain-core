import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const terraform = readFileSync(resolve(root, "infra/x402-key-vault-bootstrap/main.tf"), "utf8");
const variables = readFileSync(
  resolve(root, "infra/x402-key-vault-bootstrap/variables.tf"),
  "utf8",
);
const workflow = readFileSync(
  resolve(root, ".github/workflows/ops-x402-key-vault-bootstrap.yml"),
  "utf8",
);
const drill = readFileSync(resolve(root, "scripts/ops/x402-key-vault-restore-drill.mjs"), "utf8");
const contract = readFileSync(resolve(root, "docs/contracts/x402-seller-phase2.md"), "utf8");
const production = readFileSync(resolve(root, "infra/production.tfvars"), "utf8");
const roles = readFileSync(resolve(root, "infra/db-roles.sql"), "utf8");

describe("x402 Phase 2 Key Vault Premium custody structure", () => {
  it("creates two private purge-protected Premium vaults with a 90-day soft-delete period", () => {
    expect(terraform.match(/sku_name\s+= "premium"/g)).toHaveLength(2);
    expect(terraform.match(/public_network_access_enabled = false/g)).toHaveLength(2);
    expect(terraform.match(/purge_protection_enabled\s+= true/g)).toHaveLength(2);
    expect(terraform.match(/soft_delete_retention_days\s+= 90/g)).toHaveLength(2);
    expect(terraform).toContain('name                = "privatelink.vaultcore.azure.net"');
    expect(terraform.match(/prevent_destroy = true/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("creates a non-exportable sign-only EC-HSM P-256K key through ARM", () => {
    expect(terraform).toContain('type      = "Microsoft.KeyVault/vaults/keys@2024-11-01"');
    expect(terraform).toContain('kty       = "EC-HSM"');
    expect(terraform).toContain('curveName = "P-256K"');
    expect(terraform).toContain('keyOps    = ["sign"]');
    expect(terraform).toContain("exportable = false");
    expect(terraform).toMatch(/x402_sepolia_bootstrap_only\s+= "true"/);
  });

  it("grants the runtime identity exactly one sign action at exact key scope", () => {
    expect(terraform).toContain('name                = "brain-x402-treasury-signer"');
    expect(terraform).toContain('data_actions = ["Microsoft.KeyVault/vaults/keys/sign/action"]');
    expect(terraform).toContain("scope              = azapi_resource.seller_key.id");
    for (const forbidden of [
      "keys/create",
      "keys/import",
      "keys/export",
      "keys/backup",
      "keys/restore",
      "keys/delete",
      "keys/purge",
      "keys/rotate",
      "keys/encrypt",
      "keys/decrypt",
      "keys/wrap",
      "keys/unwrap",
    ]) {
      expect(terraform).not.toContain(forbidden);
    }
  });

  it("requires sequential Damon and Sanket approvals with no shared reviewer", () => {
    expect(workflow).toContain("environment: x402-treasury-approval");
    expect(workflow).toContain("environment: x402-security-approval");
    expect(workflow).toContain("needs: [validate, treasury-approval]");
    expect(workflow).toContain("check_environment x402-treasury-approval damonnam 6476148");
    expect(workflow).toContain(
      "check_environment x402-security-approval sanketdebnath24 124357033",
    );
    expect(contract).toMatch(/single\s+reviewer cannot satisfy both gates/);
  });

  it("alerts on control-plane, key-lifecycle, and anomalous signing activity", () => {
    expect(terraform).toContain('resource "azurerm_monitor_activity_log_alert"');
    expect(terraform).toContain('resource "azurerm_monitor_scheduled_query_rules_alert_v2"');
    for (const operation of [
      "KeyCreate",
      "KeyNewVersion",
      "KeyUpdate",
      "KeyDelete",
      "KeyRecover",
      "KeyPurge",
      "KeyBackup",
      "KeyRestore",
      "KeySign",
    ]) {
      expect(terraform).toContain(operation);
    }
    expect(terraform).toContain("attempts > 1200");
  });

  it("pins Premium custody to Base Sepolia and keeps x402 payments disabled", () => {
    expect(variables).toContain("condition     = var.chain_id == 84532");
    expect(production).toContain("enable_x402_payments = false");
    expect(production).not.toContain("x402_hsm_activated");
    expect(contract).toContain("`.vault.azure.net`");
    expect(contract).toContain("`.managedhsm.azure.net`");
    expect(contract).toMatch(/genuinely\s+new Managed HSM-generated key/);
  });

  it("provides a value-safe witnessed restore drill with fixed challenge verification", () => {
    expect(drill).toContain("process.umask(0o077)");
    expect(drill).toContain('["keyvault", "key", "backup"');
    expect(drill).toContain('["keyvault", "key", "restore"');
    expect(drill).toContain("public-key fingerprint does not match");
    expect(drill).toContain("fixed challenge verification failed");
    expect(drill).toContain('witnessed_by: ["Damon", "Sanket"]');
    expect(drill).toContain("rmSync(runDirectory, { recursive: true, force: true })");
  });

  it("does not depend on ACR, Container Apps, or Managed HSM for the bootstrap apply", () => {
    expect(terraform).not.toContain("azurerm_container_registry");
    expect(terraform).not.toContain("azurerm_container_app");
    expect(terraform).not.toContain("azurerm_key_vault_managed_hardware_security_module");
    expect(workflow).not.toContain("brainproductionacr");
    expect(workflow).not.toContain("brain-production-terraform");
    expect(contract).toMatch(/do\s+not require the paused Container Apps stack or its ACR/);
  });

  it("keeps treasury database controls behind the dedicated no-login operator", () => {
    expect(roles).toContain("CREATE ROLE brain_x402_treasury_operator NOLOGIN");
    expect(roles).toContain(
      "REVOKE ALL PRIVILEGES ON x402_seller_wallets, x402_sweep_destination_changes",
    );
    expect(roles).toContain("GRANT INSERT ON x402_seller_wallets, x402_sweep_destination_changes");
  });
});
