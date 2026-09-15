import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0046_x402_seller_protocol_control_plane.sql"),
  "utf8",
);
const roles = readFileSync(resolve(process.cwd(), "../../infra/db-roles.sql"), "utf8");
const deletion = readFileSync(resolve(process.cwd(), "src/tenant-deletion/service.ts"), "utf8");

describe("x402 seller Phase 1 schema", () => {
  it("pins v2 exact Sepolia and future-mainnet policies while disabled", () => {
    expect(migration).toContain("protocol_version = 2");
    expect(migration).toContain("settlement_timing = 'upfront'");
    expect(migration).toContain("'eip155:84532'");
    expect(migration).toContain("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(migration).toContain("enabled = FALSE");
  });

  it("fixes the launch ceiling to six read-only API and MCP operations", () => {
    expect(migration).toContain("CREATE TABLE x402_seller_operation_allowlist");
    expect(migration.match(/'x402_allow_/g)).toHaveLength(6);
    expect(migration).not.toMatch(/required_scope[^\n]+(write|propose|approve|execute)/);
  });

  it("enforces nonce, payment, operation, reservation, and retention invariants", () => {
    expect(migration).toContain("UNIQUE (nonce_digest)");
    expect(migration).toContain("payment_payload_digest TEXT       NOT NULL UNIQUE");
    expect(migration).toContain("UNIQUE (logical_operation_id)");
    expect(migration).toContain("p_now + interval '5 minutes'");
    expect(migration.match(/now\(\) \+ interval '7 years'/g)?.length).toBeGreaterThanOrEqual(5);
    expect(migration).toContain("x402 seller evidence is append-only");
  });

  it("reserves allowance atomically without granting API table mutation", () => {
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, public");
    expect(migration).toContain(
      "p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')",
    );
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION reserve_x402_allowance_unit");
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON x402_seller_operation_allowlist",
    );
  });

  it("preserves retained tenant-bound evidence and uses a narrow seller role", () => {
    expect(deletion).toContain('"x402_seller_logical_operations"');
    expect(deletion).toContain('"x402_seller_receipts"');
    expect(migration).toContain("ON DELETE SET NULL");
    expect(roles).toContain("CREATE ROLE brain_x402_seller_worker LOGIN");
    expect(roles).toContain(
      "ALTER ROLE brain_x402_seller_worker WITH LOGIN PASSWORD :'brain_x402_seller_worker_password' NOBYPASSRLS",
    );
    expect(roles).toContain(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM brain_x402_seller_worker",
    );
    expect(roles).toContain("FROM unnest(ARRAY[");
    expect(roles).toContain("column_name <> ALL (ARRAY[");
    expect(roles).toContain("'public.x402_seller_logical_operations',");
  });

  it("keeps brain_privileged read-only", () => {
    expect(migration).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|TRUNCATE)[^;]+brain_privileged/);
  });
});
