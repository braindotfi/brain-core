#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "../../services/api/node_modules/pg/lib/index.js";
import {
  PRESERVED_TABLES,
  TENANT_SCOPED_TABLES,
} from "../../services/api/dist/tenant-deletion/service.js";
import {
  COMMERCIAL_DEMO_ROW_BATCH_SIZE,
  COMMERCIAL_DEMO_TENANT_BATCH_SIZE,
  assertNoProtectedTenantIds,
  deleteTableInBatches,
} from "../../services/api/dist/tenant-deletion/batched-delete.js";

const { Pool } = pg;

const EXPECTED_TARGET_COUNT = 1519;
const EXPECTED_TARGET_SHA256 = "bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8";
const TARGET_PATH = "/tmp/commercial-demo-retirement-targets.csv";
const ACTOR = "ops-commercial-demo-retirement";
const EXPECTED_DEMO_SECOND_APPROVERS = 788;
const APPROVED_NON_BOOTSTRAP_MEMBERS = new Map([
  [
    "tnt_01KWP8B8YX3GJM4W62E3BQ3S6V:user_01KWP8B953TTGGFR444ENYYSFN",
    {
      email: "viewer@example.com",
      role: "approver",
      status: "deactivated",
      active: false,
    },
  ],
  [
    "tnt_01KX4FS0NM8JTH780M09TFCZ6M:user_01KX4FSNGFTADPGW4P8P80857D",
    {
      email: "damon@brain.fi",
      role: "viewer",
      status: "active",
      active: true,
    },
  ],
]);
const PROTECTED_TENANT_IDS = new Set([
  "tnt_00000000010000000000000000",
  "tnt_01KYAT7A1QRKHTYW9H4RAR2SEX",
  "tnt_01KYAT31JH0G043K77H8SKYG4N",
  "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
  "tnt_01M1GTBQN8R8PB6X6PN73YB6NP",
  "tnt_01M1M64ZE1R8J9TB6C3DCRKA61",
]);

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe SQL identifier: ${value}`);
  }
  return value;
}

function fixedId(prefix, seed) {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 26).toUpperCase()}`;
}

function parseTargetCsv(bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== EXPECTED_TARGET_SHA256) {
    throw new Error(`candidate-list hash mismatch: ${digest}`);
  }
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  if (lines.shift() !== "tenant_id") {
    throw new Error("candidate-list header mismatch");
  }
  const ids = lines.map((line) => line.replace(/\r$/, ""));
  if (ids.length !== EXPECTED_TARGET_COUNT || new Set(ids).size !== EXPECTED_TARGET_COUNT) {
    throw new Error(`candidate-list count or uniqueness mismatch: ${ids.length}`);
  }
  for (const id of ids) {
    if (!/^tnt_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
      throw new Error(`candidate-list contains invalid tenant id: ${id}`);
    }
  }
  assertNoProtectedTenantIds(ids, PROTECTED_TENANT_IDS);
  return { digest, ids };
}

async function insertTargets(client, ids) {
  await client.query(
    "CREATE TEMP TABLE retirement_targets (tenant_id TEXT PRIMARY KEY) ON COMMIT DROP",
  );
  const placeholders = ids.map((_, index) => `($${index + 1})`).join(",");
  await client.query(`INSERT INTO retirement_targets (tenant_id) VALUES ${placeholders}`, ids);
}

async function assertDatabaseRole(client) {
  const result = await client.query(
    `SELECT current_user AS role,
            COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypass_rls`,
  );
  const row = result.rows[0];
  if (row?.role !== "brain_tenant_deletion" || row?.bypass_rls !== true) {
    throw new Error(`unexpected database role: ${JSON.stringify(row)}`);
  }
}

async function assertRegistryCoverage(client) {
  const live = await client.query(
    `SELECT DISTINCT ON (column_name_group.table_name)
            column_name_group.table_name,
            column_name_group.column_name
       FROM (
         SELECT column_info.table_name,
                column_info.column_name,
                CASE column_info.column_name
                  WHEN 'tenant_id' THEN 1
                  WHEN 'owner_id' THEN 2
                  ELSE 3
                END AS priority
           FROM information_schema.columns column_info
           JOIN information_schema.tables relation
             ON relation.table_schema = column_info.table_schema
            AND relation.table_name = column_info.table_name
          WHERE column_info.table_schema = 'public'
            AND relation.table_type = 'BASE TABLE'
            AND column_info.column_name IN ('tenant_id', 'owner_id', 'brain_tenant_id')
       ) column_name_group
      ORDER BY column_name_group.table_name, column_name_group.priority`,
  );
  const declared = new Map(TENANT_SCOPED_TABLES.map((entry) => [entry.table, entry.column]));
  const unknown = live.rows.filter(
    (row) => !declared.has(row.table_name) && !PRESERVED_TABLES.has(row.table_name),
  );
  const mismatched = live.rows.filter(
    (row) => declared.has(row.table_name) && declared.get(row.table_name) !== row.column_name,
  );
  if (unknown.length > 0 || mismatched.length > 0) {
    throw new Error(`tenant table registry mismatch: ${JSON.stringify({ unknown, mismatched })}`);
  }
  return new Set(live.rows.map((row) => row.table_name));
}

async function scalarCount(client, sql, params = []) {
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function assertApprovedNonBootstrapMembers(client) {
  const result = await client.query(
    `SELECT member.tenant_id,
            member.id,
            lower(member.email) AS email,
            member.display_name,
            member.role,
            member.status,
            member.active,
            abs(extract(epoch FROM (member.created_at - tenant.created_at))) <= 5
              AS created_within_five_seconds,
            EXISTS (
              SELECT 1
                FROM users user_row
               WHERE user_row.tenant_id = member.tenant_id
                 AND user_row.id = member.id
            ) AS has_matching_user
       FROM members member
       JOIN retirement_targets target ON target.tenant_id = member.tenant_id
       JOIN tenants tenant ON tenant.id = member.tenant_id
      WHERE lower(member.email) NOT LIKE 'bootstrap+%@brain.invalid'
      ORDER BY member.tenant_id, member.id`,
  );

  let demoSecondApprovers = 0;
  const approvedSeen = new Set();
  const unexpected = [];
  for (const row of result.rows) {
    const isDemoSecondApprover =
      row.email === `approver2+${String(row.tenant_id).toLowerCase()}@brain.invalid` &&
      row.display_name === "Second Approver" &&
      row.role === "admin" &&
      row.status === "active" &&
      row.active === true &&
      row.created_within_five_seconds === true &&
      row.has_matching_user === false;
    if (isDemoSecondApprover) {
      demoSecondApprovers += 1;
      continue;
    }

    const key = `${row.tenant_id}:${row.id}`;
    const approved = APPROVED_NON_BOOTSTRAP_MEMBERS.get(key);
    const matchesApproved =
      approved !== undefined &&
      row.email === approved.email &&
      row.role === approved.role &&
      row.status === approved.status &&
      row.active === approved.active &&
      row.has_matching_user === false;
    if (matchesApproved) {
      approvedSeen.add(key);
      continue;
    }
    unexpected.push({ tenant_id: row.tenant_id, member_id: row.id });
  }

  if (
    result.rowCount !== EXPECTED_DEMO_SECOND_APPROVERS + APPROVED_NON_BOOTSTRAP_MEMBERS.size ||
    demoSecondApprovers !== EXPECTED_DEMO_SECOND_APPROVERS ||
    approvedSeen.size !== APPROVED_NON_BOOTSTRAP_MEMBERS.size ||
    unexpected.length !== 0
  ) {
    throw new Error(
      `approved non-bootstrap member preflight failed: ${JSON.stringify({
        total: result.rowCount,
        demo_second_approvers: demoSecondApprovers,
        approved_individual_members: approvedSeen.size,
        unexpected,
      })}`,
    );
  }

  return {
    total: result.rowCount,
    demo_second_approvers: demoSecondApprovers,
    approved_individual_members: approvedSeen.size,
  };
}

async function assertFinalPreflight(client, fenceStartedAt, liveTables) {
  const tenantSummary = await client.query(
    `SELECT COUNT(tenant.id)::int AS present,
            COUNT(*) FILTER (WHERE tenant.kind <> 'demo')::int AS non_demo,
            COUNT(*) FILTER (WHERE tenant.created_at >= '2026-09-01T00:00:00Z')::int AS september_or_later
       FROM retirement_targets target
       LEFT JOIN tenants tenant ON tenant.id = target.tenant_id`,
  );
  const summary = tenantSummary.rows[0];
  if (
    summary?.present !== EXPECTED_TARGET_COUNT ||
    summary?.non_demo !== 0 ||
    summary?.september_or_later !== 0
  ) {
    throw new Error(`tenant identity preflight failed: ${JSON.stringify(summary)}`);
  }

  const protectedCount = await scalarCount(
    client,
    `SELECT COUNT(*)
       FROM retirement_targets
      WHERE tenant_id = ANY($1::text[])`,
    [[...PROTECTED_TENANT_IDS]],
  );
  if (protectedCount !== 0) {
    throw new Error(`protected tenant preflight failed: ${protectedCount}`);
  }

  const approvedNonBootstrapMembers = await assertApprovedNonBootstrapMembers(client);

  const checks = [
    [
      "active_session_refresh_tokens",
      `SELECT COUNT(*) FROM session_refresh_tokens token JOIN retirement_targets target ON target.tenant_id = token.tenant_id WHERE token.revoked_at IS NULL AND token.expires_at > now()`,
    ],
    [
      "active_api_keys",
      `SELECT COUNT(*) FROM api_keys key JOIN retirement_targets target ON target.tenant_id = key.tenant_id WHERE key.revoked_at IS NULL AND (key.expires_at IS NULL OR key.expires_at > now())`,
    ],
    [
      "active_production_agent_tokens",
      `SELECT COUNT(*) FROM production_agent_tokens token JOIN retirement_targets target ON target.tenant_id = token.tenant_id WHERE token.revoked_at IS NULL AND token.expires_at > now()`,
    ],
    [
      "active_oauth_authorization_codes",
      `SELECT COUNT(*) FROM oauth_authorization_codes code JOIN retirement_targets target ON target.tenant_id = code.tenant_id WHERE code.consumed_at IS NULL AND code.expires_at > now()`,
    ],
    [
      "active_oauth_consent_grants",
      `SELECT COUNT(*) FROM oauth_consent_grants grant_row JOIN retirement_targets target ON target.tenant_id = grant_row.tenant_id WHERE grant_row.revoked_at IS NULL`,
    ],
    [
      "active_oauth_refresh_tokens",
      `SELECT COUNT(*) FROM oauth_refresh_tokens token JOIN retirement_targets target ON target.tenant_id = token.tenant_id WHERE token.revoked_at IS NULL AND token.rotated_at IS NULL AND token.expires_at > now()`,
    ],
    [
      "member_identity_links",
      `SELECT COUNT(*) FROM member_identity_links link JOIN retirement_targets target ON target.tenant_id = link.tenant_id`,
    ],
    [
      "wallet_identities",
      `SELECT COUNT(*) FROM wallet_identities wallet JOIN retirement_targets target ON target.tenant_id = wallet.tenant_id`,
    ],
    [
      "usable_users",
      `SELECT COUNT(*) FROM users user_row JOIN retirement_targets target ON target.tenant_id = user_row.tenant_id WHERE user_row.password_hash IS NOT NULL OR user_row.email_verified_at IS NOT NULL OR lower(user_row.email) NOT LIKE 'bootstrap+%@brain.invalid'`,
    ],
    [
      "api_request_meter_events",
      `SELECT COUNT(*) FROM api_request_meter_events event JOIN retirement_targets target ON target.tenant_id = event.tenant_id`,
    ],
    [
      "live_external_source_credentials",
      `SELECT COUNT(*) FROM raw_sources source JOIN retirement_targets target ON target.tenant_id = source.tenant_id WHERE source.encrypted_credentials IS NOT NULL AND source.status <> 'disconnected'`,
    ],
    [
      "new_raw_artifacts_since_approved_dry_run",
      `SELECT COUNT(*) FROM raw_artifacts artifact JOIN retirement_targets target ON target.tenant_id = artifact.tenant_id WHERE artifact.ingested_at >= '2026-09-03T17:55:01Z'`,
    ],
    [
      "new_raw_sources_since_approved_dry_run",
      `SELECT COUNT(*) FROM raw_sources source JOIN retirement_targets target ON target.tenant_id = source.tenant_id WHERE source.created_at >= '2026-09-03T17:55:01Z'`,
    ],
    [
      "in_flight_execution_outbox",
      `SELECT COUNT(*) FROM execution_outbox outbox JOIN retirement_targets target ON target.tenant_id = outbox.tenant_id WHERE outbox.status IN ('dispatching', 'reconciling')`,
    ],
    [
      "audit_activity_after_fence",
      `SELECT COUNT(*) FROM audit_events event JOIN retirement_targets target ON target.tenant_id = event.tenant_id WHERE event.created_at >= $1::timestamptz`,
      [fenceStartedAt],
    ],
    [
      "agent_runs_after_fence",
      `SELECT COUNT(*) FROM agent_runs run JOIN retirement_targets target ON target.tenant_id = run.tenant_id WHERE run.created_at >= $1::timestamptz`,
      [fenceStartedAt],
    ],
    [
      "proposals_after_fence",
      `SELECT COUNT(*) FROM proposals proposal JOIN retirement_targets target ON target.tenant_id = proposal.tenant_id WHERE proposal.created_at >= $1::timestamptz`,
      [fenceStartedAt],
    ],
  ];

  const results = {};
  for (const [name, sql, params = []] of checks) {
    if (!liveTables.has(sql.match(/FROM\s+([a-z_]+)/i)?.[1] ?? "")) {
      throw new Error(`preflight table is absent for check: ${name}`);
    }
    results[name] = await scalarCount(client, sql, params);
  }
  const failures = Object.entries(results).filter(([, count]) => count !== 0);
  if (failures.length > 0) {
    throw new Error(
      `credential, session, or activity preflight failed: ${JSON.stringify(results)}`,
    );
  }

  const agentFence = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE agent.state = 'quarantined')::int AS quarantined
       FROM agents agent
       JOIN retirement_targets target ON target.tenant_id = agent.tenant_id`,
  );
  const agentFenceRow = agentFence.rows[0];
  if (agentFenceRow?.total !== agentFenceRow?.quarantined) {
    throw new Error(`agent quarantine preflight failed: ${JSON.stringify(agentFenceRow)}`);
  }
  return { ...results, approvedNonBootstrapMembers, agentFence: agentFenceRow };
}

async function lockCandidateTenants(client) {
  const result = await client.query(
    `SELECT tenant.id
       FROM tenants tenant
       JOIN retirement_targets target ON target.tenant_id = tenant.id
      ORDER BY tenant.id
      FOR UPDATE OF tenant`,
  );
  if (result.rowCount !== EXPECTED_TARGET_COUNT) {
    throw new Error(`candidate tenant lock count mismatch: ${result.rowCount}`);
  }
}

async function captureCounts(client, liveTables) {
  const perTenant = new Map();
  const totals = {};
  for (const entry of TENANT_SCOPED_TABLES) {
    if (!liveTables.has(entry.table)) continue;
    const table = assertIdentifier(entry.table);
    const column = assertIdentifier(entry.column);
    const result = await client.query(
      `SELECT row.${column} AS tenant_id, COUNT(*)::int AS count
         FROM ${table} row
         JOIN retirement_targets target ON target.tenant_id = row.${column}
        GROUP BY row.${column}`,
    );
    let total = 0;
    for (const row of result.rows) {
      const count = Number(row.count);
      total += count;
      const counts = perTenant.get(row.tenant_id) ?? {};
      counts[table] = count;
      perTenant.set(row.tenant_id, counts);
    }
    totals[table] = total;
  }
  totals.tenants = EXPECTED_TARGET_COUNT;
  for (const tenantId of perTenant.keys()) {
    perTenant.get(tenantId).tenants = 1;
  }
  return { perTenant, totals };
}

async function capturePreservedCounts(client) {
  const counts = {};
  for (const tableName of PRESERVED_TABLES) {
    const table = assertIdentifier(tableName);
    counts[table] = await scalarCount(
      client,
      `SELECT COUNT(*) FROM ${table} row JOIN retirement_targets target ON target.tenant_id = row.tenant_id`,
    );
  }
  return counts;
}

async function insertBlobJobs(client, blobsByTenant) {
  for (const [tenantId, uris] of blobsByTenant) {
    await client.query(
      `INSERT INTO tenant_blob_purge_jobs
          (id, tenant_id, blob_prefix, blob_artifact_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [
        fixedId("tbp", `commercial-demo-retirement:${tenantId}`),
        tenantId,
        `${tenantId}/`,
        uris.length,
      ],
    );
  }
}

async function insertAuditOutbox(client, ids, countsByTenant, blobsByTenant, fenceStartedAt) {
  for (const tenantId of ids) {
    const deletedRows = countsByTenant.get(tenantId) ?? { tenants: 1 };
    const totalRows = Object.values(deletedRows).reduce((sum, count) => sum + count, 0);
    const uris = blobsByTenant.get(tenantId) ?? [];
    const purgeJobId =
      uris.length > 0 ? fixedId("tbp", `commercial-demo-retirement:${tenantId}`) : null;
    const deletedPayload = {
      total_rows_deleted: totalRows,
      per_table_counts: deletedRows,
      preserved: [...PRESERVED_TABLES],
      blob_artifact_count: uris.length,
      blob_uris_pending_purge: uris,
      blob_purge_job_id: purgeJobId,
      activity_fence_started_at: fenceStartedAt,
      operation: "commercial_demo_retirement",
    };
    await client.query(
      `INSERT INTO tenant_blob_purge_audit_outbox
          (id, job_id, tenant_id, action, payload, event_key, actor, inputs)
       VALUES ($1, NULL, $2, 'tenant.deleted', $3::jsonb, $4, $5, $6::jsonb)
       ON CONFLICT (event_key) DO NOTHING`,
      [
        fixedId("tbo", `commercial-demo-retirement:deleted:${tenantId}`),
        tenantId,
        JSON.stringify(deletedPayload),
        `${tenantId}:tenant.deleted`,
        ACTOR,
        JSON.stringify({ tenant_id: tenantId, requested_by: ACTOR }),
      ],
    );
    if (purgeJobId !== null) {
      const purgePayload = {
        tenant_blob_purge_job_id: purgeJobId,
        blob_prefix: `${tenantId}/`,
        blob_artifact_count: uris.length,
      };
      await client.query(
        `INSERT INTO tenant_blob_purge_audit_outbox
            (id, job_id, tenant_id, action, payload, event_key, actor, inputs)
         VALUES ($1, $2, $3, 'tenant_blob.purge_requested', $4::jsonb, $5, $6, $7::jsonb)
         ON CONFLICT (event_key) DO NOTHING`,
        [
          fixedId("tbo", `commercial-demo-retirement:purge:${tenantId}`),
          purgeJobId,
          tenantId,
          JSON.stringify(purgePayload),
          `${tenantId}:tenant_blob.purge_requested`,
          ACTOR,
          JSON.stringify({ tenant_id: tenantId, requested_by: ACTOR }),
        ],
      );
    }
  }
}

async function deleteRows(client, liveTables, expectedTotals) {
  const actual = {};
  for (const entry of TENANT_SCOPED_TABLES) {
    if (!liveTables.has(entry.table)) continue;
    const table = assertIdentifier(entry.table);
    const column = assertIdentifier(entry.column);
    actual[table] = await deleteTableInBatches(client, {
      table,
      column,
      expectedRows: expectedTotals[table],
      batchSize: COMMERCIAL_DEMO_ROW_BATCH_SIZE,
      onProgress: (progress) => console.log(JSON.stringify(progress)),
    });
  }
  actual.tenants = await deleteTableInBatches(client, {
    table: "tenants",
    column: "id",
    expectedRows: EXPECTED_TARGET_COUNT,
    batchSize: COMMERCIAL_DEMO_TENANT_BATCH_SIZE,
    onProgress: (progress) => console.log(JSON.stringify(progress)),
  });
  return actual;
}

async function assertPostDelete(client, liveTables, preservedBefore, blobsByTenant) {
  const remainingTenants = await scalarCount(
    client,
    "SELECT COUNT(*) FROM tenants tenant JOIN retirement_targets target ON target.tenant_id = tenant.id",
  );
  if (remainingTenants !== 0) throw new Error(`tenants remain after delete: ${remainingTenants}`);

  for (const entry of TENANT_SCOPED_TABLES) {
    if (!liveTables.has(entry.table)) continue;
    const table = assertIdentifier(entry.table);
    const column = assertIdentifier(entry.column);
    const remaining = await scalarCount(
      client,
      `SELECT COUNT(*) FROM ${table} row JOIN retirement_targets target ON target.tenant_id = row.${column}`,
    );
    if (remaining !== 0) throw new Error(`${table} rows remain after delete: ${remaining}`);
  }

  const preservedAfter = await capturePreservedCounts(client);
  for (const [table, before] of Object.entries(preservedBefore)) {
    const expectedIncrease =
      table === "tenant_blob_purge_jobs"
        ? blobsByTenant.size
        : table === "tenant_blob_purge_audit_outbox"
          ? EXPECTED_TARGET_COUNT + blobsByTenant.size
          : 0;
    if (preservedAfter[table] !== before + expectedIncrease) {
      throw new Error(
        `preserved table count mismatch for ${table}: before ${before}, after ${preservedAfter[table]}`,
      );
    }
  }
  return preservedAfter;
}

async function main() {
  const fenceStartedAt = requiredEnv("FENCE_STARTED_AT");
  const databaseUrl = requiredEnv("BRAIN_TENANT_DELETION_DB_URL");
  const { digest, ids } = parseTargetCsv(await readFile(TARGET_PATH));
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const transactionStartedAt = Date.now();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL statement_timeout = '3min'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
    const timeoutSettings = await client.query(
      `SELECT current_setting('transaction_isolation') AS transaction_isolation,
              current_setting('statement_timeout') AS statement_timeout,
              current_setting('lock_timeout') AS lock_timeout,
              current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout`,
    );
    console.log(
      JSON.stringify({
        event: "commercial_demo_retirement_transaction_started",
        ...timeoutSettings.rows[0],
        row_batch_size: COMMERCIAL_DEMO_ROW_BATCH_SIZE,
        tenant_batch_size: COMMERCIAL_DEMO_TENANT_BATCH_SIZE,
        started_at: new Date(transactionStartedAt).toISOString(),
      }),
    );
    await assertDatabaseRole(client);
    await insertTargets(client, ids);
    const liveTables = await assertRegistryCoverage(client);
    await lockCandidateTenants(client);
    const preflight = await assertFinalPreflight(client, fenceStartedAt, liveTables);
    const preservedBefore = await capturePreservedCounts(client);
    const { perTenant, totals } = await captureCounts(client, liveTables);
    const blobs = await client.query(
      `SELECT artifact.tenant_id, artifact.blob_uri
         FROM raw_artifacts artifact
         JOIN retirement_targets target ON target.tenant_id = artifact.tenant_id
        WHERE artifact.blob_uri IS NOT NULL
        ORDER BY artifact.tenant_id, artifact.blob_uri`,
    );
    const blobsByTenant = new Map();
    for (const row of blobs.rows) {
      const uris = blobsByTenant.get(row.tenant_id) ?? [];
      uris.push(row.blob_uri);
      blobsByTenant.set(row.tenant_id, uris);
    }
    const existingPurgeJobs = await scalarCount(
      client,
      `SELECT COUNT(*) FROM tenant_blob_purge_jobs job JOIN retirement_targets target ON target.tenant_id = job.tenant_id`,
    );
    if (existingPurgeJobs !== 0) {
      throw new Error(`candidate tenants already have blob purge jobs: ${existingPurgeJobs}`);
    }
    const existingAuditOutboxRows = await scalarCount(
      client,
      `SELECT COUNT(*) FROM tenant_blob_purge_audit_outbox outbox JOIN retirement_targets target ON target.tenant_id = outbox.tenant_id`,
    );
    if (existingAuditOutboxRows !== 0) {
      throw new Error(
        `candidate tenants already have deletion audit outbox rows: ${existingAuditOutboxRows}`,
      );
    }
    await insertBlobJobs(client, blobsByTenant);
    const deleted = await deleteRows(client, liveTables, totals);
    await insertAuditOutbox(client, ids, perTenant, blobsByTenant, fenceStartedAt);
    const preservedAfter = await assertPostDelete(
      client,
      liveTables,
      preservedBefore,
      blobsByTenant,
    );
    await client.query("COMMIT");

    console.log(
      JSON.stringify({
        event: "commercial_demo_retirement_committed",
        candidate_list_sha256: digest,
        target_count: ids.length,
        total_rows_deleted: Object.values(deleted).reduce((sum, count) => sum + count, 0),
        per_table_deleted: deleted,
        preserved_before: preservedBefore,
        preserved_after_commit: preservedAfter,
        blob_purge_jobs_enqueued: blobsByTenant.size,
        blob_artifact_rows: blobs.rows.length,
        preflight,
        fence_started_at: fenceStartedAt,
        transaction_duration_ms: Date.now() - transactionStartedAt,
        committed_at: new Date().toISOString(),
      }),
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original failure is the primary evidence.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "commercial_demo_retirement_aborted",
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
