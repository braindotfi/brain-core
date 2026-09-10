/**
 * Runtime-as-role proof for the §4 least-privilege DB roles (R-12 follow-up).
 *
 * The boot-time assertDbRoles check (services/api) proves each role is NOT too
 * loose (a forbidden-privilege list per pool). This test proves the other half
 * against a live Postgres: each role actually HOLDS the privileges its worker
 * needs (not too tight), AND still lacks the forbidden ones. It applies the
 * REAL infra/db-roles.sql (so it tests the shipped grant matrix, not a copy)
 * and uses SET ROLE to adopt each role's privileges on one superuser session.
 *
 * Requires a SUPERUSER DATABASE_URL (CREATE ROLE ... BYPASSRLS needs it) and
 * skips otherwise, so the default hermetic `pnpm test` and non-superuser CI
 * stay green. db-roles.sql is applied under the same advisory lock the
 * migration runner uses, so it cannot race a parallel test file's migrations.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

const ALL_RUNTIME_ROLES = [
  "brain_app",
  "brain_privileged",
  "brain_wiki_reader",
  "brain_mcp_reader",
  "brain_raw_worker",
  "brain_canonical_projector",
  "brain_ledger_projector",
  "brain_execution_worker",
  "brain_audit_verifier",
  "brain_audit_publisher",
  "brain_resolver",
  "brain_tenant_deletion",
  "brain_surface_gateway",
  "brain_surface_audit_writer",
  "brain_auth",
  "brain_auth_audit_writer",
] as const;

function repoRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

let pool: Pool;
let isSuper = false;

const roleModelSql = readFileSync(`${repoRoot()}/infra/db-roles.sql`, "utf8").replace(
  /LOGIN PASSWORD :'[^']+'/g,
  "LOGIN",
);

async function applyRealRoleModel(client: PoolClient): Promise<void> {
  await client.query(roleModelSql);
}

// Positive ("can") + negative ("cannot") matrix per role, derived from the
// worker footprints (services/api/src/main.ts wiring) — independent of how the
// grants are spelled in db-roles.sql.
const MATRIX: ReadonlyArray<{
  role: string;
  can: ReadonlyArray<[string, string]>;
  cannot: ReadonlyArray<[string, string]>;
}> = [
  {
    role: "brain_privileged",
    can: [["api_keys", "SELECT"]],
    cannot: [
      ["api_keys", "INSERT"],
      ["api_keys", "UPDATE"],
      ["api_keys", "DELETE"],
      ["api_keys", "TRUNCATE"],
    ],
  },
  {
    role: "brain_raw_worker",
    can: [
      ["raw_artifacts", "INSERT"],
      ["raw_parsed", "UPDATE"],
      ["raw_sync_partitions", "UPDATE"],
      ["raw_sources", "SELECT"],
      ["canonical_projection_log", "SELECT"],
    ],
    cannot: [
      ["canonical_journal_entry", "INSERT"],
      ["ledger_payment_intents", "INSERT"],
      ["audit_integrity_findings", "SELECT"],
      ["canonical_projection_log", "DELETE"],
    ],
  },
  {
    role: "brain_canonical_projector",
    can: [
      ["canonical_journal_entry", "INSERT"],
      ["canonical_projection_log", "UPDATE"],
      ["raw_parsed", "SELECT"],
    ],
    cannot: [
      ["raw_parsed", "INSERT"],
      ["ledger_payment_intents", "INSERT"],
      ["execution_outbox", "INSERT"],
    ],
  },
  {
    role: "brain_ledger_projector",
    can: [
      ["canonical_gl_account", "SELECT"],
      ["ledger_gl_accounts", "INSERT"],
      ["ledger_obligations", "INSERT"],
      ["ledger_counterparties", "UPDATE"],
    ],
    cannot: [
      ["ledger_payment_intents", "INSERT"],
      ["canonical_journal_entry", "INSERT"],
      ["execution_outbox", "INSERT"],
    ],
  },
  {
    role: "brain_execution_worker",
    can: [["execution_outbox", "UPDATE"]],
    cannot: [
      ["ledger_payment_intents", "INSERT"],
      ["ledger_transactions", "INSERT"],
      ["raw_parsed", "SELECT"],
    ],
  },
  {
    role: "brain_audit_verifier",
    can: [
      ["audit_events", "SELECT"],
      ["audit_verifier_checkpoint", "UPDATE"],
      ["audit_integrity_findings", "INSERT"],
    ],
    cannot: [
      ["audit_events", "DELETE"],
      ["audit_integrity_findings", "UPDATE"],
      ["ledger_payment_intents", "INSERT"],
    ],
  },
  {
    role: "brain_audit_publisher",
    can: [
      ["audit_events", "SELECT"],
      ["audit_anchors", "SELECT"],
    ],
    cannot: [
      ["audit_events", "INSERT"],
      ["audit_integrity_findings", "SELECT"],
      ["ledger_payment_intents", "SELECT"],
    ],
  },
  {
    role: "brain_resolver",
    can: [
      ["raw_sync_partitions", "SELECT"],
      ["wallet_identities", "SELECT"],
      ["users", "SELECT"],
    ],
    cannot: [
      ["wallet_identities", "INSERT"],
      ["ledger_payment_intents", "SELECT"],
      ["audit_integrity_findings", "SELECT"],
    ],
  },
  {
    role: "brain_tenant_deletion",
    can: [
      ["ledger_obligations", "DELETE"],
      ["tenants", "SELECT"],
      ["tenants", "UPDATE"],
      ["tenants", "DELETE"],
      ["tenant_blob_purge_jobs", "UPDATE"],
      ["raw_artifacts", "UPDATE"],
      ["audit_integrity_findings", "SELECT"],
    ],
    cannot: [
      ["audit_events", "DELETE"],
      ["audit_verifier_checkpoint", "SELECT"],
      ["audit_integrity_findings", "INSERT"],
      ["audit_integrity_findings", "UPDATE"],
      ["audit_integrity_findings", "DELETE"],
      ["audit_integrity_findings", "TRUNCATE"],
    ],
  },
  {
    role: "brain_mcp_reader",
    can: [],
    cannot: [
      ["raw_artifacts", "INSERT"],
      ["raw_artifacts", "UPDATE"],
      ["raw_artifacts", "DELETE"],
      ["raw_parsed", "INSERT"],
      ["policy_decisions", "SELECT"],
      ["policies", "SELECT"],
      ["audit_events", "SELECT"],
    ],
  },
];

suite("§4 DB role grant matrix (integration -- requires SUPERUSER DATABASE_URL)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, max: 3, application_name: "db-role-grants" });
    const who = await pool.query<{ rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    isSuper = who.rows[0]?.rolsuper === true;
    if (!isSuper) return;

    // Tables must exist before db-roles.sql grants over them. applyAll takes the
    // migration advisory lock internally; idempotent if already migrated.
    const migrations = await discoverMigrations(repoRoot());
    const client = await pool.connect();
    try {
      await applyAll(client, migrations, { appliedBy: "db-role-grants-test" });
      // Apply the REAL role model under the same advisory lock so it cannot race
      // a parallel test file's migration DDL. Password placeholders were
      // stripped above because SET ROLE needs no password.
      await client.query("SELECT pg_advisory_lock(hashtext('brain_migrations'))");
      try {
        await applyRealRoleModel(client);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext('brain_migrations'))");
      }
    } finally {
      client.release();
    }
  }, 120_000);

  afterAll(async () => {
    if (pool !== undefined) await pool.end();
  });

  for (const { role, can, cannot } of MATRIX) {
    it(`${role}: holds its grants and lacks the forbidden ones`, async (ctx) => {
      if (!isSuper) {
        ctx.skip();
        return;
      }
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE ${role}`);
        for (const [table, priv] of can) {
          const { rows } = await client.query<{ has: boolean }>(
            "SELECT has_table_privilege(current_user, $1, $2) AS has",
            [table, priv],
          );
          expect(rows[0]?.has, `${role} should hold ${priv} on ${table}`).toBe(true);
        }
        for (const [table, priv] of cannot) {
          const { rows } = await client.query<{ has: boolean }>(
            "SELECT has_table_privilege(current_user, $1, $2) AS has",
            [table, priv],
          );
          expect(rows[0]?.has, `${role} must NOT hold ${priv} on ${table}`).toBe(false);
        }
      } finally {
        await client.query("RESET ROLE").catch(() => undefined);
        client.release();
      }
    });
  }

  it("self-heals stale brain_privileged api_keys grants and is idempotent", async (ctx) => {
    if (!isSuper) {
      ctx.skip();
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public " +
          "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brain_privileged",
      );
      await client.query(
        "GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON api_keys TO brain_privileged",
      );
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const) {
        const stale = await client.query<{ has: boolean }>(
          "SELECT has_table_privilege('brain_privileged', 'api_keys', $1) AS has",
          [privilege],
        );
        expect(stale.rows[0]?.has, `stale ${privilege} grant fixture was not installed`).toBe(true);
      }

      await applyRealRoleModel(client);

      await client.query("DROP TABLE IF EXISTS brain_privileged_default_acl_probe");
      await client.query("CREATE TABLE brain_privileged_default_acl_probe (id INTEGER)");
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const) {
        const inherited = await client.query<{ has: boolean }>(
          "SELECT has_table_privilege(" +
            "'brain_privileged', 'brain_privileged_default_acl_probe', $1) AS has",
          [privilege],
        );
        expect(inherited.rows[0]?.has, `default ACL retained ${privilege}`).toBe(false);
      }

      await client.query("SET ROLE brain_privileged");
      await expect(client.query("SELECT count(*) FROM api_keys")).resolves.toBeDefined();
      const deniedStatements = [
        ["insert", "INSERT INTO api_keys DEFAULT VALUES"],
        ["update", "UPDATE api_keys SET name = name WHERE false"],
        ["delete", "DELETE FROM api_keys WHERE false"],
        ["truncate", "TRUNCATE api_keys"],
      ] as const;
      for (const [name, sql] of deniedStatements) {
        await client.query(`SAVEPOINT denied_${name}`);
        await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
        await client.query(`ROLLBACK TO SAVEPOINT denied_${name}`);
        await client.query(`RELEASE SAVEPOINT denied_${name}`);
      }
      await client.query("RESET ROLE");

      await applyRealRoleModel(client);
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const) {
        const result = await client.query<{ has: boolean }>(
          "SELECT has_table_privilege('brain_privileged', 'api_keys', $1) AS has",
          [privilege],
        );
        expect(result.rows[0]?.has, `unexpected ${privilege} after second apply`).toBe(
          privilege === "SELECT",
        );
      }
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("no runtime role can delete or truncate audit anchors", async (ctx) => {
    if (!isSuper) {
      ctx.skip();
      return;
    }
    const client = await pool.connect();
    try {
      for (const role of ALL_RUNTIME_ROLES) {
        await client.query(`SET ROLE ${role}`);
        for (const privilege of ["DELETE", "TRUNCATE"] as const) {
          const { rows } = await client.query<{ has: boolean }>(
            "SELECT has_table_privilege(current_user, 'audit_anchors', $1) AS has",
            [privilege],
          );
          expect(rows[0]?.has, `${role} must NOT hold ${privilege} on audit_anchors`).toBe(false);
        }
        await client.query("RESET ROLE");
      }
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  });

  it("brain_mcp_reader: holds only approved Raw column-level SELECT grants", async (ctx) => {
    if (!isSuper) {
      ctx.skip();
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("SET ROLE brain_mcp_reader");
      const allowedArtifactColumns = [
        "id",
        "tenant_id",
        "sha256",
        "source_type",
        "source_ref",
        "mime_type",
        "bytes",
        "ingested_at",
        "tombstoned_at",
        "ingested_by",
        "source_schema",
        "object_type",
        "external_id",
        "operation",
        "effective_at",
        "observed_at",
        "original_source",
        "intermediaries",
        "source_id",
        "source_version",
        "idempotency_key",
      ];
      const allowedParsedColumns = [
        "id",
        "raw_artifact_id",
        "tenant_id",
        "parser",
        "parser_version",
        "extracted",
        "confidence",
        "extracted_at",
      ];
      for (const column of allowedArtifactColumns) {
        const { rows } = await client.query<{ has: boolean }>(
          "SELECT has_column_privilege(current_user, 'raw_artifacts', $1, 'SELECT') AS has",
          [column],
        );
        expect(rows[0]?.has, `brain_mcp_reader should read raw_artifacts.${column}`).toBe(true);
      }
      for (const column of allowedParsedColumns) {
        const { rows } = await client.query<{ has: boolean }>(
          "SELECT has_column_privilege(current_user, 'raw_parsed', $1, 'SELECT') AS has",
          [column],
        );
        expect(rows[0]?.has, `brain_mcp_reader should read raw_parsed.${column}`).toBe(true);
      }
      for (const column of ["blob_uri"]) {
        const { rows } = await client.query<{ has: boolean }>(
          "SELECT has_column_privilege(current_user, 'raw_artifacts', $1, 'SELECT') AS has",
          [column],
        );
        expect(rows[0]?.has, `brain_mcp_reader must not read raw_artifacts.${column}`).toBe(false);
      }
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
  });
});
