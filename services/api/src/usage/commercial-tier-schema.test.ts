import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0029_self_serve_commercial_tiers.sql"),
  "utf8",
);
const main = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
const entityBackfill = readFileSync(
  resolve(process.cwd(), "../audit/migrations/0023_robotmoney_default_entity_backfill.sql"),
  "utf8",
);
const shadowMigration = readFileSync(
  resolve(process.cwd(), "migrations/0030_commercial_shadow_observations.sql"),
  "utf8",
);

describe("RFC 0011 Phase 1 commercial tier schema", () => {
  it("uses immutable accepted catalog revisions without placeholders", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS api_commercial_tier_catalog");
    expect(migration).toContain("UNIQUE (public_tier_id, revision)");
    expect(migration).toContain(
      "placeholder           BOOLEAN     NOT NULL DEFAULT FALSE CHECK (placeholder = FALSE)",
    );
    expect(migration).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE");
    expect(migration).not.toContain("Pricing pending");
  });

  it("pins the approved public limits and prices", () => {
    expect(migration).toContain("'robotmoney_free_v1', 'free'");
    expect(migration).toContain("'robotmoney_starter_v1', 'starter'");
    expect(migration).toContain("'robotmoney_growth_v1', 'growth'");
    expect(migration).toContain("'robotmoney_scale_v1', 'scale'");
    expect(migration).toContain("'robotmoney_enterprise_v1', 'enterprise'");
    expect(migration).toContain("'robotmoney_growth_usd_month_v1'");
    expect(migration).toContain("'robotmoney_scale_usd_year_v1'");
    expect(migration).toContain("'robotmoney_starter_eur_month_v1'");
    expect(migration).toContain("'robotmoney_growth_gbp_year_v1'");
    expect(migration).toContain("spot_rate_source");
    expect(migration).toContain("rounding_decimal_places INTEGER");
    expect(migration).toContain("'x402_api_base_mainnet_v1'");
    expect(migration).toContain("'x402_mcp_base_mainnet_v1'");
    expect(migration).toContain("'fraud_stopped_v1', 'fraud_stopped', 1, 200, 1000, NULL");
  });

  it("retains a billing account for seven years after its final tenant unlink", () => {
    expect(migration).toContain("retain_unlinked_commercial_billing_account");
    expect(migration).toContain("now() + interval '7 years'");
    expect(migration).toContain("accounting_and_settlement_evidence");
  });

  it("assigns every current responsibility to Damon's canonical actor", () => {
    expect(migration).toContain("user_01M0NTPB2292Z4BF5BHVEM41C6");
    expect(migration).toContain("assigned_by = 'user_01M0NTPB2292Z4BF5BHVEM41C6'");
  });

  it("backfills exactly one entity from canonical historical business names", () => {
    expect(entityBackfill).toContain("payload ->> 'legalBusinessName'");
    expect(entityBackfill).toContain("inputs ->> 'company_name'");
    expect(entityBackfill).toContain("without a recoverable business name");
    expect(entityBackfill).toContain("INSERT INTO robotmoney_entities");
    expect(entityBackfill).not.toContain("robotmoney_free_v1");
  });

  it("makes the minimum 30-day shadow period structurally observe-only", () => {
    expect(shadowMigration).toContain("minimum_days >= 30");
    expect(shadowMigration).toContain("enforcement_applied = FALSE");
    expect(shadowMigration).toContain("catalog_resolution IN ('explicit', 'unresolved')");
    expect(shadowMigration).not.toContain("GRANT UPDATE ON commercial_shadow_observations");
  });

  it("creates every approved contract ledger", () => {
    for (const table of [
      "commercial_activation_gates",
      "commercial_tier_prices",
      "commercial_billing_accounts",
      "robotmoney_entities",
      "robotmoney_agent_instances",
      "tenant_commercial_entitlements",
      "commercial_stripe_subscriptions",
      "commercial_stripe_events",
      "api_usage_allowance_counters",
      "api_usage_allowance_reservations",
      "commercial_execution_periods",
      "commercial_execution_reservations",
      "commercial_charge_facts",
      "x402_payment_operations",
      "commercial_provider_commands",
      "commercial_responsibility_assignments",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("keeps activation, publication, and application writes disabled", () => {
    expect(migration).toContain("mode                  TEXT        NOT NULL DEFAULT 'disabled'");
    expect(migration).toContain("enabled               BOOLEAN     NOT NULL DEFAULT FALSE");
    expect(migration).toContain("self_serve_enabled    BOOLEAN     NOT NULL DEFAULT FALSE");
    expect(migration).not.toContain("GRANT INSERT ON");
    expect(migration).not.toContain("GRANT UPDATE ON");
  });

  it("forces RLS on every tenant-owned commercial table", () => {
    for (const table of [
      "robotmoney_entities",
      "robotmoney_agent_instances",
      "tenant_commercial_entitlements",
      "commercial_stripe_subscriptions",
      "api_usage_allowance_counters",
      "api_usage_allowance_reservations",
      "commercial_execution_periods",
      "commercial_execution_reservations",
      "commercial_charge_facts",
      "x402_payment_operations",
    ]) {
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toMatch(
        new RegExp(`CREATE POLICY [^\\n]+ ON ${table}\\n  FOR SELECT USING \\(tenant_id =`),
      );
    }
  });

  it("stores provider references and digests but no provider credentials", () => {
    expect(migration).toContain("provider_price_reference TEXT");
    expect(migration).toContain("payment_payload_digest TEXT");
    expect(migration).not.toMatch(/api_secret|secret_key|private_key|wallet_seed/i);
  });

  it("does not register the commercial HTTP surface unless its default-off gate is true", () => {
    expect(main).toMatch(
      /if \(cfg\.BRAIN_COMMERCIAL_CATALOG_ENABLED\) \{[\s\S]+registerCommercialTierRoutes/,
    );
  });
});
