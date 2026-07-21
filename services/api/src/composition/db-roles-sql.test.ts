/**
 * Structural guard over infra/db-roles.sql for the §4 least-privilege roles.
 *
 * This does not need a database: it asserts the grant matrix in the SQL matches
 * the documented per-role footprint, so a future edit can't silently widen a
 * scoped role or drop a critical REVOKE. The RUNTIME proof that each pool
 * actually connects as its role with exactly these privileges is the boot-time
 * assertDbRoles check in main.ts (forbidden lists per pool); the "not too tight"
 * proof (each worker can do its job as its role) is left to a runtime-as-role
 * integration test (follow-up) and the existing worker integration suites.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(new URL("../../../../infra/db-roles.sql", import.meta.url), "utf8");

const ROLES = [
  "brain_raw_worker",
  "brain_canonical_projector",
  "brain_ledger_projector",
  "brain_execution_worker",
  "brain_audit_verifier",
  "brain_audit_publisher",
  "brain_resolver",
  "brain_tenant_deletion",
] as const;

const RUNTIME_ROLES = [...ROLES, "brain_mcp_reader"] as const;

describe("infra/db-roles.sql — §4 least-privilege roles", () => {
  it("creates all eight roles as BYPASSRLS", () => {
    for (const role of ROLES) {
      expect(SQL, `${role} missing from CREATE loop`).toContain(`'${role}'`);
      expect(SQL, `${role} ALTER ... BYPASSRLS missing`).toMatch(
        new RegExp(`ALTER ROLE ${role}\\s+WITH LOGIN PASSWORD :'${role}_password' BYPASSRLS`),
      );
    }
  });

  it("creates brain_mcp_reader as a tenant-scoped read-only role", () => {
    expect(SQL).toContain("CREATE ROLE brain_mcp_reader LOGIN");
    expect(SQL).toMatch(
      /ALTER ROLE brain_mcp_reader\s+WITH LOGIN PASSWORD :'brain_mcp_reader_password' NOBYPASSRLS/,
    );
    expect(SQL).toContain(
      "GRANT USAGE ON SCHEMA public TO brain_app, brain_privileged, brain_wiki_reader,\n  brain_mcp_reader",
    );
  });

  it("does NOT add privileged roles to the blanket all-tables grant", () => {
    const blanket = SQL.match(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES[\s\S]*?;/);
    expect(blanket).not.toBeNull();
    for (const role of ROLES) {
      expect(blanket?.[0]).not.toContain(role);
    }
    expect(blanket?.[0]).not.toContain("brain_privileged");
    expect(blanket?.[0]).not.toContain("brain_mcp_reader");
    expect(blanket?.[0]).toContain("brain_app");
  });

  it("limits brain_privileged to the seed and verifier footprint", () => {
    expect(SQL).toContain(
      "GRANT SELECT, INSERT, UPDATE ON tenants, policies, members TO brain_privileged",
    );
    expect(SQL).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON agents TO brain_privileged");
    expect(SQL).toContain(
      "GRANT SELECT, INSERT, UPDATE ON audit_verifier_checkpoint TO brain_privileged",
    );
    expect(SQL).toContain("GRANT SELECT, INSERT ON audit_integrity_findings TO brain_privileged");
  });

  it("scopes each worker role to its layer", () => {
    expect(SQL).toMatch(/GRANT SELECT, INSERT, UPDATE ON %s TO brain_raw_worker/);
    expect(SQL).toMatch(/GRANT SELECT, INSERT, UPDATE ON %s TO brain_canonical_projector/);
    expect(SQL).toContain("GRANT DELETE ON canonical_journal_line TO brain_canonical_projector");
    expect(SQL).toContain("GRANT SELECT ON raw_parsed TO brain_canonical_projector");
    // ledger projector: SELECT canonical_*, write only projection targets.
    expect(SQL).toMatch(/GRANT SELECT ON %s TO brain_ledger_projector/);
    expect(SQL).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON ledger_gl_accounts, ledger_obligations, ledger_counterparties,\s+ledger_accounts, ledger_transactions\s+TO brain_ledger_projector/,
    );
    // execution worker: outbox only.
    expect(SQL).toContain(
      "GRANT SELECT, INSERT, UPDATE ON execution_outbox TO brain_execution_worker",
    );
    // audit verifier: audit_events read, audit_anchors scan/heal, forensic cursor.
    expect(SQL).toContain("GRANT SELECT ON audit_events TO brain_audit_verifier");
    expect(SQL).toContain("GRANT SELECT, UPDATE ON audit_anchors TO brain_audit_verifier");
  });

  it("scopes the read-only roles to SELECT", () => {
    expect(SQL).toContain("GRANT SELECT ON audit_events TO brain_audit_publisher");
    expect(SQL).toContain(
      "GRANT SELECT ON raw_sync_partitions, wallet_identities, users, members, member_identity_links",
    );
    expect(SQL).toContain("member_invites, session_refresh_tokens, api_keys TO brain_resolver");
    const artifactGrant = SQL.match(
      /GRANT SELECT \(([\s\S]*?)\) ON raw_artifacts TO brain_mcp_reader/,
    );
    expect(artifactGrant).not.toBeNull();
    expect(artifactGrant?.[1]).toContain("id, tenant_id, sha256, source_type, source_ref");
    expect(artifactGrant?.[1]).toContain("idempotency_key");
    expect(artifactGrant?.[1]).not.toContain("blob_uri");
    const parsedGrant = SQL.match(/GRANT SELECT \(([\s\S]*?)\) ON raw_parsed TO brain_mcp_reader/);
    expect(parsedGrant).not.toBeNull();
    expect(parsedGrant?.[1]).toContain("id, raw_artifact_id, tenant_id, parser");
    expect(SQL).not.toMatch(/GRANT (?:SELECT, )?INSERT[^;]*TO brain_mcp_reader/);
    expect(SQL).not.toMatch(/GRANT (?:SELECT, INSERT, )?UPDATE[^;]*TO brain_mcp_reader/);
    expect(SQL).not.toMatch(/GRANT (?:SELECT, INSERT, UPDATE, )?DELETE[^;]*TO brain_mcp_reader/);
    expect(SQL).not.toContain("ON policy_decisions TO brain_mcp_reader");
    expect(SQL).not.toContain("ON policies TO brain_mcp_reader");
    expect(SQL).not.toContain("ON audit_events TO brain_mcp_reader");
  });

  it("keeps audit history immutable to every new role (incl. tenant_deletion)", () => {
    const revoke = SQL.match(/REVOKE UPDATE, DELETE, TRUNCATE ON audit_events\s+FROM[\s\S]*?;/);
    expect(revoke).not.toBeNull();
    for (const role of RUNTIME_ROLES) {
      expect(revoke?.[0], `${role} not in audit_events REVOKE`).toContain(role);
    }
    const insertRevoke = SQL.match(/REVOKE INSERT ON audit_events\s+FROM[\s\S]*?;/);
    expect(insertRevoke).not.toBeNull();
    expect(insertRevoke?.[0]).toContain("brain_privileged");
    expect(insertRevoke?.[0]).not.toContain("brain_app");
  });

  it("keeps forensic state off-limits to every new role except the verifier", () => {
    const revokeAll = SQL.match(
      /REVOKE ALL ON audit_verifier_checkpoint, audit_integrity_findings\s+FROM[\s\S]*?;/,
    );
    expect(revokeAll).not.toBeNull();
    for (const role of RUNTIME_ROLES) {
      if (role === "brain_audit_verifier") {
        expect(revokeAll?.[0]).not.toContain(role); // verifier keeps scoped access
      } else {
        expect(revokeAll?.[0], `${role} not stripped of forensic tables`).toContain(role);
      }
    }
    // The verifier still cannot erase a detected break.
    expect(SQL).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON audit_integrity_findings\s+FROM brain_privileged, brain_audit_verifier/,
    );
  });
});
