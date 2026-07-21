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
import { Pool } from "pg";
import { applyAll, discoverMigrations } from "../../../tools/migrate/src/index.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

function repoRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

let pool: Pool;
let isSuper = false;

// Positive ("can") + negative ("cannot") matrix per role, derived from the
// worker footprints (services/api/src/main.ts wiring) — independent of how the
// grants are spelled in db-roles.sql.
const MATRIX: ReadonlyArray<{
  role: string;
  can: ReadonlyArray<[string, string]>;
  cannot: ReadonlyArray<[string, string]>;
}> = [
  {
    role: "brain_raw_worker",
    can: [
      ["raw_artifacts", "INSERT"],
      ["raw_parsed", "UPDATE"],
      ["raw_sync_partitions", "UPDATE"],
      ["raw_sources", "SELECT"],
    ],
    cannot: [
      ["canonical_journal_entry", "INSERT"],
      ["ledger_payment_intents", "INSERT"],
      ["audit_integrity_findings", "SELECT"],
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
    can: [["audit_events", "SELECT"]],
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
      ["tenants", "DELETE"],
      ["tenant_blob_purge_jobs", "UPDATE"],
      ["raw_artifacts", "UPDATE"],
    ],
    cannot: [
      ["audit_events", "DELETE"],
      ["audit_integrity_findings", "SELECT"],
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
      // a parallel test file's migration DDL. Strip the psql :'var' password
      // placeholders (SET ROLE needs no password; we never change real ones).
      const sql = readFileSync(`${repoRoot()}/infra/db-roles.sql`, "utf8").replace(
        /LOGIN PASSWORD :'[^']+'/g,
        "LOGIN",
      );
      await client.query("SELECT pg_advisory_lock(hashtext('brain_migrations'))");
      try {
        await client.query(sql);
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
