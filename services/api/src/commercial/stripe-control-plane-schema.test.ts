import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0045_commercial_stripe_test_control_plane.sql"),
  "utf8",
);
const roles = readFileSync(resolve(process.cwd(), "../../infra/db-roles.sql"), "utf8");

describe("commercial Stripe Phase 1 schema", () => {
  it("creates durable customer, immutable price, webhook, and operator evidence", () => {
    for (const table of [
      "commercial_stripe_customers",
      "commercial_stripe_price_bindings",
      "commercial_stripe_webhook_inbox",
      "commercial_stripe_webhook_processing_attempts",
      "commercial_stripe_catalog_operation_receipts",
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration).toContain("commercial Stripe evidence is append-only");
    expect(migration).toContain("BEFORE TRUNCATE ON commercial_stripe_webhook_inbox");
  });

  it("rejects live-mode rows and pins API and webhook versions", () => {
    expect(migration.match(/CHECK \(provider_mode = 'test'\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(migration.match(/CHECK \(livemode = FALSE\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(migration).toContain("2026-02-25.clover");
  });

  it("keeps brain_privileged read-only and grants the dedicated role narrowly", () => {
    expect(migration).toContain("FROM brain_privileged");
    expect(migration).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|TRUNCATE)[^;]+brain_privileged/);
    expect(roles).toContain("CREATE ROLE brain_stripe_billing_worker NOLOGIN");
    expect(roles).toContain(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM brain_stripe_billing_worker",
    );
    expect(roles).toContain("TO brain_stripe_billing_worker");
  });
});
