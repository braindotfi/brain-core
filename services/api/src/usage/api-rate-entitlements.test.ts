import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0024_api_rate_limit_entitlements.sql"),
  "utf8",
);

describe("API rate entitlement schema", () => {
  it("seeds immutable tier revisions and server defaults", () => {
    for (const tierId of [
      "sandbox_demo_v1",
      "starter_v1",
      "standard_v1",
      "scale_v1",
      "enterprise_v1",
    ]) {
      expect(migration).toContain(`'${tierId}'`);
    }
    expect(migration).toContain("CREATE TRIGGER tenants_create_default_api_entitlements");
    expect(migration).toContain("AFTER INSERT ON tenants");
    expect(migration).toContain("'live', 'scale_v1', 'migration_preserve_legacy_600'");
    expect(migration).toContain("''live'', ''starter_v1'', ''tenant_provisioning''");
  });

  it("creates defaults in the trigger table's schema without trusting caller search path", () => {
    expect(migration).toContain("SET search_path = pg_catalog, pg_temp");
    expect(migration).toContain("'INSERT INTO %I.tenant_api_entitlements '");
    expect(migration).toContain("TG_TABLE_SCHEMA");
    expect(migration).not.toContain("SET search_path = public, pg_temp");
  });

  it("forces tenant RLS and binds overrides to a key in the same tenant", () => {
    expect(migration).toContain("ALTER TABLE tenant_api_entitlements FORCE ROW LEVEL SECURITY");
    expect(migration).toContain(
      "ALTER TABLE api_key_rate_limit_overrides FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(tenant_id, key_id\)\s+REFERENCES api_keys\(tenant_id, id\) ON DELETE CASCADE/,
    );
  });

  it("removes entitlement mutation from the normal request role", () => {
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenant_api_entitlements FROM brain_app",
    );
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_key_rate_limit_overrides FROM brain_app",
    );
  });
});
