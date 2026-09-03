import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0027_tenant_graduation_verification.sql"),
  "utf8",
);
const repository = readFileSync(resolve(process.cwd(), "src/graduation/repository.ts"), "utf8");
const phase2Migration = readFileSync(
  resolve(process.cwd(), "migrations/0028_tenant_graduation_provisioning.sql"),
  "utf8",
);
const provisioningRepository = readFileSync(
  resolve(process.cwd(), "src/graduation/provisioning-repository.ts"),
  "utf8",
);
const memberForeignKeys = readFileSync(
  resolve(process.cwd(), "../execution/migrations/0035_tenant_graduation_member_foreign_keys.sql"),
  "utf8",
);

describe("RFC 0010 Phase 1 graduation schema", () => {
  it.each([
    "tenant_graduation_requests",
    "tenant_graduation_evidence",
    "tenant_graduation_assessments",
    "tenant_graduation_review_decisions",
  ])("forces tenant RLS on %s", (table) => {
    expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  });

  it("keeps evidence, assessments, and review decisions append-only", () => {
    expect(migration).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON tenant_graduation_evidence,[\s\S]*tenant_graduation_review_decisions FROM PUBLIC/,
    );
    expect(migration).not.toContain(
      "GRANT SELECT, INSERT, UPDATE ON tenant_graduation_review_decisions TO brain_app",
    );
  });

  it("does not add a destination tenant or mutate source tenant classification", () => {
    expect(migration).not.toContain("destination_tenant_id");
    expect(migration).not.toMatch(/UPDATE\s+tenants/i);
  });

  it("requires durable email verification before treating a member email as controlled", () => {
    expect(repository).toContain("u.email_verified_at IS NOT NULL");
    expect(repository).toContain("u.status = 'active'");
  });

  it("defers member references until the execution service has created members", () => {
    expect(migration).not.toContain("REFERENCES members");
    expect(memberForeignKeys).toContain(
      "tenant_graduation_requests_initiated_by_member_fk",
    );
    expect(memberForeignKeys).toContain("tenant_graduation_evidence_submitted_by_member_fk");
    expect(memberForeignKeys).toContain("REFERENCES members(tenant_id, id)");
  });
});

describe("RFC 0010 Phase 2 unpaid graduation schema", () => {
  it("stores immutable tenant-scoped lineage with a hard no-financial-copy assertion", () => {
    expect(phase2Migration).toContain("CREATE TABLE IF NOT EXISTS tenant_graduation_lineage");
    expect(phase2Migration).toContain("CHECK (financial_data_copied = FALSE)");
    expect(phase2Migration).toContain(
      "ALTER TABLE tenant_graduation_lineage FORCE ROW LEVEL SECURITY",
    );
    expect(phase2Migration).toContain(
      "REVOKE UPDATE, DELETE, TRUNCATE ON tenant_graduation_lineage FROM brain_app",
    );
  });

  it("creates a new customer tenant without updating the source tenant", () => {
    expect(provisioningRepository).toContain("INSERT INTO tenants");
    expect(provisioningRepository).toContain("'customer', 'production'");
    expect(provisioningRepository).not.toMatch(/UPDATE\s+tenants/i);
  });

  it("accepts either an automated clear assessment or the latest manual clear decision", () => {
    expect(provisioningRepository).toContain("tenant_graduation_review_decisions");
    expect(provisioningRepository).toContain('row.review_decision !== "clear"');
  });

  it("never copies synthetic financial or credential tables", () => {
    for (const table of [
      "ledger_accounts",
      "ledger_transactions",
      "raw_artifacts",
      "sources",
      "api_keys",
      "proposals",
    ]) {
      expect(provisioningRepository).not.toContain(`INSERT INTO ${table}`);
    }
  });
});
