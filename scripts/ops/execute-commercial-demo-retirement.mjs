#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "../../services/api/node_modules/pg/lib/index.js";
import {
  PRESERVED_TABLES,
  TENANT_SCOPED_TABLES,
  tenantDeleteStatement,
} from "../../services/api/dist/tenant-deletion/service.js";
import { assertNoProtectedTenantIds } from "../../services/api/dist/tenant-deletion/batched-delete.js";
import { assertTenantDeletionPrivilegeContract } from "../../services/api/dist/tenant-deletion/privilege-contract.js";
import {
  COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID,
  initializeRetirementProgress,
  listRetirementProgress,
  runRetirementTenantAttempt,
} from "../../services/api/dist/tenant-deletion/per-tenant-retirement.js";

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

export function parseTargetCsv(bytes) {
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

export async function assertDatabaseRole(client) {
  const result = await client.query(
    `SELECT current_user AS role,
            COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypass_rls`,
  );
  const row = result.rows[0];
  if (row?.role !== "brain_tenant_deletion" || row?.bypass_rls !== true) {
    throw new Error(`unexpected database role: ${JSON.stringify(row)}`);
  }
}

export async function assertRegistryCoverage(client) {
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

function classifyApprovedNonBootstrapMembers(rows, requireFullCohort) {
  let demoSecondApprovers = 0;
  const approvedSeen = new Set();
  const unexpected = [];
  for (const row of rows) {
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

  const exactFullCohortMismatch =
    requireFullCohort &&
    (rows.length !== EXPECTED_DEMO_SECOND_APPROVERS + APPROVED_NON_BOOTSTRAP_MEMBERS.size ||
      demoSecondApprovers !== EXPECTED_DEMO_SECOND_APPROVERS ||
      approvedSeen.size !== APPROVED_NON_BOOTSTRAP_MEMBERS.size);
  if (exactFullCohortMismatch || unexpected.length !== 0) {
    throw new Error(
      `approved non-bootstrap member preflight failed: ${JSON.stringify({
        total: rows.length,
        demo_second_approvers: demoSecondApprovers,
        approved_individual_members: approvedSeen.size,
        unexpected,
      })}`,
    );
  }

  return {
    total: rows.length,
    demo_second_approvers: demoSecondApprovers,
    approved_individual_members: approvedSeen.size,
  };
}

async function selectNonBootstrapMembers(client, predicate, values = []) {
  return client.query(
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
        AND ${predicate}
      ORDER BY member.tenant_id, member.id`,
    values,
  );
}

async function assertApprovedNonBootstrapMembers(client, requireFullCohort) {
  const result = await selectNonBootstrapMembers(client, "true");
  return classifyApprovedNonBootstrapMembers(result.rows, requireFullCohort);
}

async function assertFinalPreflight(client, fenceStartedAt, liveTables, options = {}) {
  const completedTenantIds = options.completedTenantIds ?? [];
  const expectedPresent = options.expectedPresent ?? EXPECTED_TARGET_COUNT;
  const tenantSummary = await client.query(
    `SELECT COUNT(tenant.id)::int AS present,
            COUNT(*) FILTER (WHERE tenant.kind <> 'demo')::int AS non_demo,
            COUNT(*) FILTER (WHERE tenant.created_at >= '2026-09-01T00:00:00Z')::int AS september_or_later,
            COUNT(*) FILTER (
              WHERE tenant.id = ANY($1::text[])
            )::int AS completed_still_present
       FROM retirement_targets target
       LEFT JOIN tenants tenant ON tenant.id = target.tenant_id`,
    [completedTenantIds],
  );
  const summary = tenantSummary.rows[0];
  if (
    summary?.present !== expectedPresent ||
    summary?.non_demo !== 0 ||
    summary?.september_or_later !== 0 ||
    summary?.completed_still_present !== 0
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

  const approvedNonBootstrapMembers = await assertApprovedNonBootstrapMembers(
    client,
    options.requireFullMemberCohort ?? true,
  );

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

async function captureCounts(client, liveTables, ids) {
  const perTenant = new Map(ids.map((tenantId) => [tenantId, { tenants: 1 }]));
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
  return { perTenant, totals };
}

export async function captureTenantCounts(client, liveTables, tenantId) {
  const counts = { tenants: 1 };
  for (const entry of TENANT_SCOPED_TABLES) {
    if (!liveTables.has(entry.table)) continue;
    const table = assertIdentifier(entry.table);
    const column = assertIdentifier(entry.column);
    counts[table] = await scalarCount(
      client,
      `SELECT COUNT(*) FROM ${table} WHERE ${column} = $1`,
      [tenantId],
    );
  }
  return counts;
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

async function deleteTenantRows(client, liveTables, tenantId, expectedRows) {
  const actual = {};
  for (const entry of TENANT_SCOPED_TABLES) {
    if (!liveTables.has(entry.table)) continue;
    const table = assertIdentifier(entry.table);
    const column = assertIdentifier(entry.column);
    const result = await client.query(tenantDeleteStatement(table, column), [tenantId]);
    actual[table] = result.rowCount ?? 0;
    if (actual[table] !== (expectedRows[table] ?? 0)) {
      throw new Error(
        `delete count mismatch for ${tenantId} ${table}: expected ${expectedRows[table] ?? 0}, got ${actual[table]}`,
      );
    }
  }
  const tenantResult = await client.query(tenantDeleteStatement("tenants", "id"), [tenantId]);
  actual.tenants = tenantResult.rowCount ?? 0;
  if (actual.tenants !== 1) {
    throw new Error(
      `delete count mismatch for ${tenantId} tenants: expected 1, got ${actual.tenants}`,
    );
  }
  return actual;
}

async function assertPostDelete(
  client,
  liveTables,
  preservedBefore,
  blobsByTenant,
  expectedTargetCount = 1,
) {
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
          ? expectedTargetCount + blobsByTenant.size
          : 0;
    if (preservedAfter[table] !== before + expectedIncrease) {
      throw new Error(
        `preserved table count mismatch for ${table}: before ${before}, after ${preservedAfter[table]}`,
      );
    }
  }
  return preservedAfter;
}

function assertCountSnapshot(tenantId, expected, actual) {
  const tables = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const mismatches = [...tables]
    .sort()
    .filter((table) => Number(expected[table] ?? 0) !== Number(actual[table] ?? 0))
    .map((table) => ({
      table,
      expected: Number(expected[table] ?? 0),
      actual: Number(actual[table] ?? 0),
    }));
  if (mismatches.length > 0) {
    throw new Error(
      `per-tenant count preflight failed for ${tenantId}: ${JSON.stringify(mismatches)}`,
    );
  }
}

function assertProgressMatches(progressRows, digest, ids) {
  if (progressRows.length !== ids.length) {
    throw new Error(`retirement progress count mismatch: ${progressRows.length}`);
  }
  for (let index = 0; index < ids.length; index += 1) {
    const row = progressRows[index];
    if (
      row?.tenant_id !== ids[index] ||
      row.ordinal !== index + 1 ||
      row.candidate_list_sha256 !== digest
    ) {
      throw new Error(`retirement progress candidate mismatch at ordinal ${index + 1}`);
    }
  }
}

export async function executeOneTenant(client, tenantId, expectedRows, fenceStartedAt, liveTables) {
  await insertTargets(client, [tenantId]);
  await client.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
  await assertFinalPreflight(client, fenceStartedAt, liveTables, {
    expectedPresent: 1,
    requireFullMemberCohort: false,
  });
  const actualBefore = await captureTenantCounts(client, liveTables, tenantId);
  assertCountSnapshot(tenantId, expectedRows, actualBefore);
  const preservedBefore = await capturePreservedCounts(client);
  const blobs = await client.query(
    `SELECT blob_uri
       FROM raw_artifacts
      WHERE tenant_id = $1 AND blob_uri IS NOT NULL
      ORDER BY blob_uri`,
    [tenantId],
  );
  const blobUris = blobs.rows.map(({ blob_uri }) => blob_uri);
  const blobsByTenant = new Map(blobUris.length > 0 ? [[tenantId, blobUris]] : []);
  const existingPurgeJobs = await scalarCount(
    client,
    "SELECT COUNT(*) FROM tenant_blob_purge_jobs WHERE tenant_id = $1",
    [tenantId],
  );
  const existingAuditOutboxRows = await scalarCount(
    client,
    "SELECT COUNT(*) FROM tenant_blob_purge_audit_outbox WHERE tenant_id = $1",
    [tenantId],
  );
  if (existingPurgeJobs !== 0 || existingAuditOutboxRows !== 0) {
    throw new Error(
      `retirement evidence already exists for ${tenantId}: purge=${existingPurgeJobs}, outbox=${existingAuditOutboxRows}`,
    );
  }

  await insertBlobJobs(client, blobsByTenant);
  const deleted = await deleteTenantRows(client, liveTables, tenantId, expectedRows);
  await insertAuditOutbox(
    client,
    [tenantId],
    new Map([[tenantId, expectedRows]]),
    blobsByTenant,
    fenceStartedAt,
  );
  await assertPostDelete(client, liveTables, preservedBefore, blobsByTenant);
  return {
    deletedRows: deleted,
    totalRowsDeleted: Object.values(deleted).reduce((sum, count) => sum + count, 0),
    blobPurgeJobId:
      blobUris.length > 0 ? fixedId("tbp", `commercial-demo-retirement:${tenantId}`) : null,
    blobArtifactCount: blobUris.length,
  };
}

async function initializeOrValidateRun(pool, digest, ids, fenceStartedAt) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '45s'");
    await assertDatabaseRole(client);
    await insertTargets(client, ids);
    const liveTables = await assertRegistryCoverage(client);
    const privilegeReport = await assertTenantDeletionPrivilegeContract(
      client,
      TENANT_SCOPED_TABLES.filter(({ table }) => liveTables.has(table)).map(({ table }) => table),
    );
    let progressRows = await listRetirementProgress(client);
    if (progressRows.length === 0) {
      const preflight = await assertFinalPreflight(client, fenceStartedAt, liveTables);
      const { perTenant } = await captureCounts(client, liveTables, ids);
      await initializeRetirementProgress(
        client,
        digest,
        ids.map((tenantId, index) => ({
          tenantId,
          ordinal: index + 1,
          expectedRows: perTenant.get(tenantId),
        })),
      );
      progressRows = await listRetirementProgress(client);
      console.log(
        JSON.stringify({
          event: "commercial_demo_retirement_progress_initialized",
          operation_id: COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID,
          target_count: progressRows.length,
          preflight,
        }),
      );
    } else {
      assertProgressMatches(progressRows, digest, ids);
      const completedTenantIds = progressRows
        .filter(({ status }) => status === "completed")
        .map(({ tenant_id }) => tenant_id);
      await assertFinalPreflight(client, fenceStartedAt, liveTables, {
        completedTenantIds,
        expectedPresent: ids.length - completedTenantIds.length,
        requireFullMemberCohort: false,
      });
      console.log(
        JSON.stringify({
          event: "commercial_demo_retirement_progress_resumed",
          operation_id: COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID,
          completed: completedTenantIds.length,
          remaining: ids.length - completedTenantIds.length,
        }),
      );
    }
    assertProgressMatches(progressRows, digest, ids);
    await client.query("COMMIT");
    return { liveTables, privilegeReport, progressRows };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function completionReport(pool) {
  const summary = await pool.query(
    `SELECT status, COUNT(*)::int AS count
       FROM commercial_demo_retirement_progress
      WHERE operation_id = $1
      GROUP BY status
      ORDER BY status`,
    [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID],
  );
  const totals = await pool.query(
    `SELECT COALESCE(SUM(total_rows_deleted), 0)::bigint AS total_rows_deleted,
            COALESCE(SUM(blob_artifact_count), 0)::int AS blob_artifact_rows,
            COUNT(*) FILTER (WHERE blob_purge_job_id IS NOT NULL)::int AS blob_purge_jobs_enqueued
       FROM commercial_demo_retirement_progress
      WHERE operation_id = $1 AND status = 'completed'`,
    [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID],
  );
  const perTable = await pool.query(
    `SELECT entry.key AS table_name, SUM((entry.value)::bigint)::bigint AS rows_deleted
       FROM commercial_demo_retirement_progress progress
       CROSS JOIN LATERAL jsonb_each_text(progress.deleted_rows) entry
      WHERE progress.operation_id = $1 AND progress.status = 'completed'
      GROUP BY entry.key
      ORDER BY entry.key`,
    [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID],
  );
  const failures = await pool.query(
    `SELECT tenant_id, attempt_count, last_error
       FROM commercial_demo_retirement_progress
      WHERE operation_id = $1 AND status <> 'completed'
      ORDER BY ordinal`,
    [COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID],
  );
  return {
    statuses: summary.rows,
    totals: totals.rows[0],
    per_table_deleted: Object.fromEntries(
      perTable.rows.map(({ table_name, rows_deleted }) => [table_name, Number(rows_deleted)]),
    ),
    failures: failures.rows,
  };
}

async function main() {
  const startedAt = Date.now();
  const fenceStartedAt = requiredEnv("FENCE_STARTED_AT");
  const databaseUrl = requiredEnv("BRAIN_TENANT_DELETION_DB_URL");
  const { digest, ids } = parseTargetCsv(await readFile(TARGET_PATH));
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const { liveTables, privilegeReport, progressRows } = await initializeOrValidateRun(
      pool,
      digest,
      ids,
      fenceStartedAt,
    );
    console.log(
      JSON.stringify({
        event: "commercial_demo_retirement_privilege_preflight_passed",
        ...privilegeReport,
      }),
    );

    let processed = 0;
    for (const progress of progressRows) {
      const attempt = await runRetirementTenantAttempt(
        pool,
        progress.tenant_id,
        (client, expectedRows) =>
          executeOneTenant(client, progress.tenant_id, expectedRows, fenceStartedAt, liveTables),
      );
      processed += 1;
      console.log(
        JSON.stringify({
          event: "commercial_demo_retirement_tenant_finished",
          ordinal: progress.ordinal,
          processed,
          target_count: ids.length,
          ...attempt,
        }),
      );
    }

    const report = await completionReport(pool);
    const complete = report.failures.length === 0;
    console.log(
      JSON.stringify({
        event: complete
          ? "commercial_demo_retirement_committed"
          : "commercial_demo_retirement_completed_with_failures",
        operation_id: COMMERCIAL_DEMO_RETIREMENT_OPERATION_ID,
        candidate_list_sha256: digest,
        target_count: ids.length,
        total_rows_deleted: Number(report.totals.total_rows_deleted),
        per_table_deleted: report.per_table_deleted,
        blob_purge_jobs_enqueued: report.totals.blob_purge_jobs_enqueued,
        blob_artifact_rows: report.totals.blob_artifact_rows,
        statuses: report.statuses,
        failures: report.failures,
        fence_started_at: fenceStartedAt,
        execution_duration_ms: Date.now() - startedAt,
        completed_at: new Date().toISOString(),
      }),
    );
    if (!complete) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
}
