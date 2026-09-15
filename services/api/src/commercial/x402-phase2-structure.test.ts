import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const terraform = readFileSync(resolve(root, "infra/x402-hsm.tf"), "utf8");
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

  it("grants the dedicated identity only sign on the one seller key", () => {
    expect(terraform).toContain('name                = "brain-x402-treasury-signer"');
    expect(terraform).toContain(
      'data_actions = ["Microsoft.KeyVault/managedHsm/keys/sign/action"]',
    );
    expect(terraform).toContain('scope              = "/keys/${');
    expect(terraform).not.toContain("keys/create");
    expect(terraform).not.toContain("keys/delete");
  });

  it("makes the recovery copy encrypted, immutable, and geo-redundant", () => {
    expect(terraform).toMatch(/account_replication_type\s*=\s*"GRS"/);
    expect(terraform).toMatch(/infrastructure_encryption_enabled\s*=\s*true/);
    expect(terraform).toMatch(/immutability_period_in_days\s*=\s*2555/);
    expect(contract).toContain("quorum of three");
    expect(contract).toContain("five named custodians");
  });

  it("stops the first apply before HSM activation and key creation", () => {
    expect(tfvars).toContain("enable_x402_phase2_custody = true");
    expect(tfvars).toContain("x402_hsm_activated         = false");
    expect(terraform).toContain("count          = var.x402_hsm_activated ? 1 : 0");
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
