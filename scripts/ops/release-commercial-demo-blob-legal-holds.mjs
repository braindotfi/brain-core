#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire("/app/services/api/package.json");
const { Client } = require("pg");
const {
  GetObjectLegalHoldCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  PutObjectLegalHoldCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { brainId } = await import("/app/shared/dist/ids.js");

const EXPECTED_MANIFEST_SHA256 = "90a7217ff41c9530a738fc05b2e6b7bb759cf2a62ecc1e6a733398d45ff44483";
const EXPECTED_CANDIDATE_SHA256 =
  "bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8";
const EXPECTED_CANDIDATES = 1519;
const EXPECTED_JOBS = 24;
const EXPECTED_KEYS = 68;
const EXPECTED_VERSIONS = 69;
const OPERATION_ID = "commercial-demo-retirement-2026-09-03";
const ACTOR = "ops-commercial-demo-legal-hold-release";
const POLL_INTERVAL_MS = 5_000;
const PURGE_TIMEOUT_MS = 15 * 60 * 1_000;
const protectedTenantIds = [
  "tnt_00000000010000000000000000",
  "tnt_01KYAT7A1QRKHTYW9H4RAR2SEX",
  "tnt_01KYAT31JH0G043K77H8SKYG4N",
  "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
  "tnt_01M1GTBQN8R8PB6X6PN73YB6NP",
  "tnt_01M1M64ZE1R8J9TB6C3DCRKA61",
];

const approvedManifest = process.env.APPROVED_MANIFEST_SHA256;
const bucket = process.env.BLOB_CONTAINER;
const dbUrl = process.env.BRAIN_TENANT_DELETION_DB_URL;

assert(approvedManifest === EXPECTED_MANIFEST_SHA256, "approved manifest hash mismatch");
assert(bucket, "BLOB_CONTAINER is required");
assert(dbUrl, "BRAIN_TENANT_DELETION_DB_URL is required");

const db = new Client({ connectionString: dbUrl });
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

function assert(condition, message) {
  if (!condition) throw new Error(`legal hold release failed closed: ${message}`);
}

function emit(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pairId(key, versionId) {
  return JSON.stringify([key, versionId]);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function splitHeldPath(value) {
  const at = value.lastIndexOf("@");
  assert(at > 0 && at < value.length - 1, "malformed held key and version pair");
  return { key: value.slice(0, at), versionId: value.slice(at + 1) };
}

function errorCode(error) {
  return error && typeof error === "object"
    ? String(error.name || error.Code || error.code || "unknown")
    : "unknown";
}

async function listPrefix(prefix) {
  const versions = [];
  const deleteMarkers = [];
  let keyMarker;
  let versionIdMarker;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    );
    versions.push(...(page.Versions || []));
    deleteMarkers.push(...(page.DeleteMarkers || []));
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker || versionIdMarker);
  return { versions, deleteMarkers };
}

function inventoryDigest(inventory) {
  const lines = [
    ...inventory.versions
      .filter((row) => row.Key && row.VersionId)
      .map((row) => JSON.stringify(["version", row.Key, row.VersionId])),
    ...inventory.deleteMarkers
      .filter((row) => row.Key && row.VersionId)
      .map((row) => JSON.stringify(["delete-marker", row.Key, row.VersionId])),
  ].sort();
  return {
    versions: inventory.versions.length,
    delete_markers: inventory.deleteMarkers.length,
    sha256: sha256(`${lines.join("\n")}\n`),
  };
}

function canonicalManifestHash(rows) {
  const lines = rows
    .map((row) => JSON.stringify([row.jobId, row.tenantId, row.key, row.versionId]))
    .sort();
  return sha256(`${lines.join("\n")}\n`);
}

async function loadAndValidateManifest({ requireHoldsOn }) {
  await db.query("BEGIN TRANSACTION READ ONLY");
  try {
    const progress = await db.query(
      `SELECT COUNT(*)::int AS candidates,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
              COUNT(DISTINCT candidate_list_sha256)::int AS hash_count,
              MIN(candidate_list_sha256) AS candidate_hash
         FROM commercial_demo_retirement_progress
        WHERE operation_id = $1`,
      [OPERATION_ID],
    );
    const progressRow = progress.rows[0];
    assert(progressRow.candidates === EXPECTED_CANDIDATES, "candidate count changed");
    assert(progressRow.completed === EXPECTED_CANDIDATES, "candidate progress is incomplete");
    assert(progressRow.hash_count === 1, "candidate progress contains multiple hashes");
    assert(
      progressRow.candidate_hash === EXPECTED_CANDIDATE_SHA256,
      "original candidate hash changed",
    );

    const jobs = await db.query(
      `SELECT job.id, job.tenant_id, job.status, job.attempts,
              job.blob_artifact_count, job.deleted_count,
              job.legal_hold_paths, job.locked_at, job.locked_by
         FROM tenant_blob_purge_jobs job
         JOIN commercial_demo_retirement_progress progress
           ON progress.operation_id = $1
          AND progress.tenant_id = job.tenant_id
          AND progress.blob_purge_job_id = job.id
        WHERE progress.status = 'completed'
          AND job.id IN (
            SELECT requested.job_id
              FROM tenant_blob_purge_audit_outbox requested
             WHERE requested.action = 'tenant_blob.purge_requested'
               AND requested.actor = 'ops-commercial-demo-retirement'
          )
        ORDER BY job.tenant_id, job.id`,
      [OPERATION_ID],
    );
    assert(jobs.rowCount === EXPECTED_JOBS, "purge job count changed");
    assert(
      new Set(jobs.rows.map((row) => row.tenant_id)).size === EXPECTED_JOBS,
      "purge jobs are not one-to-one with tenants",
    );
    assert(
      jobs.rows.every((row) => row.status === "blocked_legal_hold"),
      "a purge job is not blocked_legal_hold",
    );
    assert(
      jobs.rows.every((row) => row.locked_at === null && row.locked_by === null),
      "a purge job is currently leased",
    );
    assert(
      jobs.rows.reduce((sum, row) => sum + row.blob_artifact_count, 0) === EXPECTED_KEYS,
      "artifact-row count changed",
    );

    const tenantIds = jobs.rows.map((row) => row.tenant_id);
    const tenantSet = new Set(tenantIds);
    const manifest = jobs.rows.flatMap((job) =>
      job.legal_hold_paths.map((value) => ({
        jobId: job.id,
        tenantId: job.tenant_id,
        ...splitHeldPath(value),
      })),
    );
    const pairSet = new Set(manifest.map((row) => pairId(row.key, row.versionId)));
    const keySet = new Set(manifest.map((row) => row.key));
    assert(manifest.length === EXPECTED_VERSIONS, "held version count changed");
    assert(pairSet.size === EXPECTED_VERSIONS, "held version manifest contains duplicates");
    assert(keySet.size === EXPECTED_KEYS, "held unique-key count changed");
    assert(canonicalManifestHash(manifest) === approvedManifest, "manifest hash changed");

    for (const tenantId of protectedTenantIds) {
      assert(!tenantSet.has(tenantId), `protected tenant ${tenantId} is in the job set`);
      assert(
        manifest.every((row) => !row.key.startsWith(`${tenantId}/`)),
        `protected tenant ${tenantId} is in the object manifest`,
      );
    }
    for (const row of manifest) {
      assert(
        row.key.startsWith(`${row.tenantId}/`),
        `object prefix does not match ${row.tenantId}`,
      );
    }

    const deletionEvidence = await db.query(
      `SELECT uri.value AS blob_uri
         FROM tenant_blob_purge_audit_outbox deleted
         CROSS JOIN LATERAL jsonb_array_elements_text(
           deleted.payload->'blob_uris_pending_purge'
         ) uri(value)
        WHERE deleted.action = 'tenant.deleted'
          AND deleted.actor = 'ops-commercial-demo-retirement'
          AND deleted.tenant_id = ANY($1::text[])
        ORDER BY deleted.tenant_id, uri.value`,
      [tenantIds],
    );
    const evidenceKeySet = new Set(deletionEvidence.rows.map((row) => row.blob_uri));
    assert(deletionEvidence.rowCount === EXPECTED_KEYS, "deletion evidence count changed");
    assert(evidenceKeySet.size === EXPECTED_KEYS, "deletion evidence keys are not unique");
    assert(
      sameSet(evidenceKeySet, keySet),
      "manifest keys differ from original tenant.deleted evidence",
    );

    const byTenant = new Map();
    for (const row of manifest) {
      const rows = byTenant.get(row.tenantId) || [];
      rows.push(row);
      byTenant.set(row.tenantId, rows);
    }
    for (const job of jobs.rows) {
      const expected = byTenant.get(job.tenant_id) || [];
      const expectedPairs = new Set(expected.map((row) => pairId(row.key, row.versionId)));
      const inventory = await listPrefix(`${job.tenant_id}/`);
      const actualPairs = new Set(
        inventory.versions
          .filter((row) => row.Key && row.VersionId)
          .map((row) => pairId(row.Key, row.VersionId)),
      );
      assert(
        inventory.deleteMarkers.length === 0,
        `unexpected delete marker under ${job.tenant_id}`,
      );
      assert(
        sameSet(actualPairs, expectedPairs),
        `object version inventory changed under ${job.tenant_id}`,
      );
      if (requireHoldsOn) {
        for (const row of expected) {
          const hold = await s3.send(
            new GetObjectLegalHoldCommand({
              Bucket: bucket,
              Key: row.key,
              VersionId: row.versionId,
            }),
          );
          assert(hold.LegalHold?.Status === "ON", `legal hold is not ON for ${job.tenant_id}`);
          try {
            const retention = await s3.send(
              new GetObjectRetentionCommand({
                Bucket: bucket,
                Key: row.key,
                VersionId: row.versionId,
              }),
            );
            assert(
              !retention.Retention,
              `an independent retention rule exists for ${job.tenant_id}`,
            );
          } catch (error) {
            assert(
              errorCode(error) === "NoSuchObjectLockConfiguration",
              `retention check failed for ${job.tenant_id}: ${errorCode(error)}`,
            );
          }
        }
      }
    }
    await db.query("COMMIT");
    return { jobs: jobs.rows, manifest, tenantIds };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function enqueueReleaseRequested(jobs, manifest) {
  await db.query("BEGIN");
  try {
    for (const job of jobs) {
      const jobManifest = manifest.filter((row) => row.jobId === job.id);
      const eventKey = `${job.id}:tenant_blob.legal_hold_release_requested:${approvedManifest}`;
      await db.query(
        `INSERT INTO tenant_blob_purge_audit_outbox
          (id, job_id, tenant_id, action, payload, event_key, actor, inputs)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)
         ON CONFLICT (event_key) DO NOTHING`,
        [
          brainId("tbo"),
          job.id,
          job.tenant_id,
          "tenant_blob.legal_hold_release_requested",
          JSON.stringify({
            manifest_sha256: approvedManifest,
            job_manifest_sha256: canonicalManifestHash(jobManifest),
            unique_keys: new Set(jobManifest.map((row) => row.key)).size,
            key_version_pairs: jobManifest.length,
          }),
          eventKey,
          ACTOR,
          JSON.stringify({ operation_id: OPERATION_ID }),
        ],
      );
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function clearAndVerifyHolds(manifest) {
  let released = 0;
  for (const row of manifest) {
    await s3.send(
      new PutObjectLegalHoldCommand({
        Bucket: bucket,
        Key: row.key,
        VersionId: row.versionId,
        LegalHold: { Status: "OFF" },
      }),
    );
    released += 1;
    emit("legal_hold_version_released", {
      released,
      expected: EXPECTED_VERSIONS,
      tenant_id: row.tenantId,
      key_sha256: sha256(row.key).slice(0, 16),
      version_id_sha256: sha256(row.versionId).slice(0, 16),
    });
  }
  for (const row of manifest) {
    const hold = await s3.send(
      new GetObjectLegalHoldCommand({
        Bucket: bucket,
        Key: row.key,
        VersionId: row.versionId,
      }),
    );
    assert(
      hold.LegalHold?.Status === "OFF",
      `released version did not report OFF for ${row.tenantId}`,
    );
  }
  emit("legal_hold_release_verified", { versions: released, status: "OFF" });
}

async function requeueJobs(jobs, manifest) {
  await db.query("BEGIN");
  try {
    const locked = await db.query(
      `SELECT id, tenant_id, status, legal_hold_paths
         FROM tenant_blob_purge_jobs
        WHERE id = ANY($1::text[])
        ORDER BY id
        FOR UPDATE`,
      [jobs.map((job) => job.id)],
    );
    assert(locked.rowCount === EXPECTED_JOBS, "locked requeue job count changed");
    assert(
      locked.rows.every((row) => row.status === "blocked_legal_hold"),
      "a locked job is no longer blocked_legal_hold",
    );
    const lockedManifest = locked.rows.flatMap((job) =>
      job.legal_hold_paths.map((value) => ({
        jobId: job.id,
        tenantId: job.tenant_id,
        ...splitHeldPath(value),
      })),
    );
    assert(
      canonicalManifestHash(lockedManifest) === approvedManifest,
      "locked job manifest hash changed",
    );

    for (const job of jobs) {
      const jobManifest = manifest.filter((row) => row.jobId === job.id);
      const payload = JSON.stringify({
        manifest_sha256: approvedManifest,
        job_manifest_sha256: canonicalManifestHash(jobManifest),
        unique_keys: new Set(jobManifest.map((row) => row.key)).size,
        key_version_pairs: jobManifest.length,
      });
      for (const action of [
        "tenant_blob.legal_hold_released",
        "tenant_blob.purge_requeued_after_hold_release",
      ]) {
        await db.query(
          `INSERT INTO tenant_blob_purge_audit_outbox
            (id, job_id, tenant_id, action, payload, event_key, actor, inputs)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)
           ON CONFLICT (event_key) DO NOTHING`,
          [
            brainId("tbo"),
            job.id,
            job.tenant_id,
            action,
            payload,
            `${job.id}:${action}:${approvedManifest}`,
            ACTOR,
            JSON.stringify({ operation_id: OPERATION_ID }),
          ],
        );
      }
    }
    const updated = await db.query(
      `UPDATE tenant_blob_purge_jobs
          SET status = 'pending', attempts = 0, next_attempt_at = now(),
              deleted_count = 0, legal_hold_paths = '{}', last_error = NULL,
              locked_at = NULL, locked_by = NULL, completed_at = NULL
        WHERE id = ANY($1::text[])
          AND status = 'blocked_legal_hold'`,
      [jobs.map((job) => job.id)],
    );
    assert(updated.rowCount === EXPECTED_JOBS, "requeued job count changed");
    await db.query("COMMIT");
    emit("legal_hold_jobs_requeued", { jobs: updated.rowCount });
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function waitForPurge(jobIds) {
  const deadline = Date.now() + PURGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await db.query(
      `SELECT status, COUNT(*)::int AS count
         FROM tenant_blob_purge_jobs
        WHERE id = ANY($1::text[])
        GROUP BY status
        ORDER BY status`,
      [jobIds],
    );
    emit("blob_purge_progress", {
      statuses: Object.fromEntries(result.rows.map((row) => [row.status, row.count])),
    });
    if (
      result.rows.length === 1 &&
      result.rows[0].status === "completed" &&
      result.rows[0].count === EXPECTED_JOBS
    )
      return;
    assert(
      !result.rows.some((row) => ["blocked_legal_hold", "exhausted"].includes(row.status)),
      "a requeued purge job reached a terminal failure state",
    );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("legal hold release failed closed: timed out waiting for blob purge completion");
}

async function waitForAudit(jobIds) {
  const deadline = Date.now() + PURGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'published')::int AS published
         FROM tenant_blob_purge_audit_outbox
        WHERE job_id = ANY($1::text[])
          AND (
            event_key LIKE '%' || $2
            OR action = 'tenant_blob.purge_completed'
          )`,
      [jobIds, approvedManifest],
    );
    const row = result.rows[0];
    emit("legal_hold_release_audit_progress", row);
    if (row.total === EXPECTED_JOBS * 4 && row.published === EXPECTED_JOBS * 4) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("legal hold release failed closed: timed out waiting for audit publication");
}

async function reconcile(jobs, tenantIds, protectedBefore) {
  const jobIds = jobs.map((job) => job.id);
  const result = await db.query(
    `SELECT COUNT(*)::int AS jobs,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
            COALESCE(SUM(deleted_count), 0)::int AS deleted_versions,
            COALESCE(SUM(blob_artifact_count), 0)::int AS artifact_keys,
            COUNT(*) FILTER (WHERE cardinality(legal_hold_paths) <> 0)::int AS jobs_with_held_paths
       FROM tenant_blob_purge_jobs
      WHERE id = ANY($1::text[])`,
    [jobIds],
  );
  const summary = result.rows[0];
  assert(summary.jobs === EXPECTED_JOBS, "final job count changed");
  assert(summary.completed === EXPECTED_JOBS, "not all purge jobs completed");
  assert(summary.deleted_versions === EXPECTED_VERSIONS, "deleted version count mismatch");
  assert(summary.artifact_keys === EXPECTED_KEYS, "artifact key count mismatch");
  assert(summary.jobs_with_held_paths === 0, "completed jobs retain legal_hold_paths");

  let remainingVersions = 0;
  let remainingDeleteMarkers = 0;
  for (const tenantId of tenantIds) {
    const inventory = await listPrefix(`${tenantId}/`);
    remainingVersions += inventory.versions.length;
    remainingDeleteMarkers += inventory.deleteMarkers.length;
  }
  assert(remainingVersions === 0, "retirement object versions remain");
  assert(remainingDeleteMarkers === 0, "retirement delete markers remain");

  const protectedAfter = new Map();
  for (const tenantId of protectedTenantIds) {
    const digest = inventoryDigest(await listPrefix(`${tenantId}/`));
    protectedAfter.set(tenantId, digest);
    assert(
      JSON.stringify(digest) === JSON.stringify(protectedBefore.get(tenantId)),
      `protected prefix changed for ${tenantId}`,
    );
  }
  emit("legal_hold_release_reconciliation", {
    contract_passed: true,
    manifest_sha256: approvedManifest,
    jobs: summary.jobs,
    completed_jobs: summary.completed,
    unique_keys_removed: summary.artifact_keys,
    versions_removed: summary.deleted_versions,
    remaining_versions: remainingVersions,
    remaining_delete_markers: remainingDeleteMarkers,
    protected_prefixes_unchanged: protectedTenantIds.length,
  });
}

await db.connect();
try {
  emit("legal_hold_release_started", { manifest_sha256: approvedManifest });
  const { jobs, manifest, tenantIds } = await loadAndValidateManifest({ requireHoldsOn: true });
  emit("legal_hold_release_preflight_passed", {
    jobs: jobs.length,
    tenants: tenantIds.length,
    unique_keys: new Set(manifest.map((row) => row.key)).size,
    key_version_pairs: manifest.length,
  });

  const protectedBefore = new Map();
  for (const tenantId of protectedTenantIds) {
    protectedBefore.set(tenantId, inventoryDigest(await listPrefix(`${tenantId}/`)));
  }
  emit("legal_hold_protected_prefix_baseline", {
    prefixes: [...protectedBefore].map(([tenantId, digest]) => ({
      tenant_id: tenantId,
      ...digest,
    })),
  });

  await enqueueReleaseRequested(jobs, manifest);
  emit("legal_hold_release_audit_intents_committed", { jobs: jobs.length });
  await clearAndVerifyHolds(manifest);
  await requeueJobs(jobs, manifest);
  await waitForPurge(jobs.map((job) => job.id));
  await waitForAudit(jobs.map((job) => job.id));
  await reconcile(jobs, tenantIds, protectedBefore);
} finally {
  await db.end();
  s3.destroy();
}
