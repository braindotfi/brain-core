import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0027_tenant_graduation_verification.sql"),
  "utf8",
);
const repository = readFileSync(resolve(process.cwd(), "src/graduation/repository.ts"), "utf8");

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
});
