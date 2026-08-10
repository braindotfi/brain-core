/**
 * Repair historical duplicate unresolved Collections proposals.
 *
 * Default mode is read-only and reports every duplicate `(tenant_id, invoice_id)`
 * group. `--apply` keeps the newest pending proposal per invoice, marks older
 * rows `superseded`, links them to the retained proposal, and emits one
 * append-only audit event per superseded row.
 *
 * Run inside the production API image through the fixed operations workflow:
 *   node scripts/ops/cleanup-collections-duplicate-proposals.mjs
 *   node scripts/ops/cleanup-collections-duplicate-proposals.mjs --apply
 */

import { parseArgs } from "node:util";
import { Pool } from "pg";
import { PostgresAuditEmitter } from "@brain/shared";

const COLLECTIONS_PROPOSAL_LOCK_NAMESPACE = 0x434f4c4c; // "COLL"

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`missing required env: ${name}`);
  return value;
}

function parseOptions() {
  const { values } = parseArgs({
    options: { apply: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help === true) {
    process.stdout.write("Usage: cleanup-collections-duplicate-proposals [--apply]\n");
    process.exit(0);
  }
  return { apply: values.apply === true };
}

async function duplicateGroups(pool) {
  await pool.query("BEGIN TRANSACTION READ ONLY");
  try {
    await pool.query("SET LOCAL statement_timeout = '10s'");
    await pool.query("SET LOCAL lock_timeout = '1s'");
    const { rows } = await pool.query(
      `WITH ranked AS (
         SELECT tenant_id,
                action->>'invoice_id' AS invoice_id,
                id,
                created_at,
                row_number() OVER (
                  PARTITION BY tenant_id, action->>'invoice_id'
                  ORDER BY created_at DESC, id DESC
                ) AS position,
                count(*) OVER (PARTITION BY tenant_id, action->>'invoice_id') AS group_size
           FROM proposals
          WHERE proposing_agent = 'collections'
            AND status = 'pending'
            AND action->>'type' = 'collections'
            AND NULLIF(action->>'invoice_id', '') IS NOT NULL
       )
       SELECT tenant_id,
              invoice_id,
              max(group_size)::int AS unresolved_count,
              max(id) FILTER (WHERE position = 1) AS keep_proposal_id,
              array_agg(id ORDER BY created_at DESC, id DESC) FILTER (WHERE position > 1)
                AS supersede_proposal_ids
         FROM ranked
        WHERE group_size > 1
        GROUP BY tenant_id, invoice_id
        ORDER BY tenant_id, invoice_id`,
    );
    await pool.query("COMMIT");
    return rows;
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function unresolvedCount(pool) {
  await pool.query("BEGIN TRANSACTION READ ONLY");
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count
         FROM proposals
        WHERE proposing_agent = 'collections'
          AND status = 'pending'
          AND action->>'type' = 'collections'
          AND NULLIF(action->>'invoice_id', '') IS NOT NULL`,
    );
    await pool.query("COMMIT");
    return rows[0]?.count ?? 0;
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function supersedeGroup(appPool, audit, group) {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [group.tenant_id]);
    await client.query(
      `SELECT pg_advisory_xact_lock(${COLLECTIONS_PROPOSAL_LOCK_NAMESPACE}, hashtext($1))`,
      [`${group.tenant_id}:collections:${group.invoice_id}`],
    );
    const { rows } = await client.query(
      `SELECT id, action, status
         FROM proposals
        WHERE proposing_agent = 'collections'
          AND status = 'pending'
          AND action->>'type' = 'collections'
          AND action->>'invoice_id' = $1
        ORDER BY created_at DESC, id DESC
        FOR UPDATE`,
      [group.invoice_id],
    );
    if (rows.length <= 1) {
      await client.query("COMMIT");
      return { kept: rows[0]?.id ?? null, superseded: [] };
    }

    const [current, ...duplicates] = rows;
    for (const duplicate of duplicates) {
      await audit.emit({
        tenantId: group.tenant_id,
        layer: "agent",
        actor: "collections_duplicate_cleanup",
        action: "agent.action.superseded",
        inputs: {
          proposal_id: duplicate.id,
          invoice_id: group.invoice_id,
          retained_proposal_id: current.id,
        },
        outputs: {
          status: "superseded",
          reason: "duplicate_unresolved_collections_proposal",
        },
        beforeState: { id: duplicate.id, status: duplicate.status, action: duplicate.action },
        afterState: { id: duplicate.id, status: "superseded", superseded_by: current.id },
        idempotencyKey: `collections-duplicate-cleanup:${duplicate.id}:${current.id}`,
      });
    }

    const duplicateIds = duplicates.map((row) => row.id);
    await client.query(
      `UPDATE proposals
          SET status = 'superseded',
              superseded_at = now(),
              superseded_by = $2,
              updated_at = now()
        WHERE id = ANY($1::text[])
          AND status = 'pending'`,
      [duplicateIds, current.id],
    );
    await client.query("COMMIT");
    return { kept: current.id, superseded: duplicateIds };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const { apply } = parseOptions();
  const appPool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
  // Cross-tenant reporting needs the deploy owner: brain_audit_verifier is
  // deliberately restricted to audit tables and cannot inspect proposals.
  // This pool is used only by the fixed BEGIN TRANSACTION READ ONLY queries.
  const ownerPool = new Pool({
    connectionString: `postgres://brain:${encodeURIComponent(
      requireEnv("POSTGRES_PASSWORD"),
    )}@postgres:5432/brain`,
  });
  const audit = new PostgresAuditEmitter(appPool);
  try {
    const unresolvedBefore = await unresolvedCount(ownerPool);
    const groups = await duplicateGroups(ownerPool);
    const proposalsToSupersede = groups.reduce(
      (count, group) => count + group.supersede_proposal_ids.length,
      0,
    );
    process.stdout.write(`mode=${apply ? "apply" : "report"}\n`);
    process.stdout.write(`unresolved_before=${unresolvedBefore}\n`);
    process.stdout.write(`duplicate_groups=${groups.length}\n`);
    process.stdout.write(`proposals_to_supersede=${proposalsToSupersede}\n`);
    for (const group of groups) process.stdout.write(`${JSON.stringify(group)}\n`);

    if (!apply) return;

    let superseded = 0;
    for (const group of groups) {
      const result = await supersedeGroup(appPool, audit, group);
      superseded += result.superseded.length;
      process.stdout.write(
        `${JSON.stringify({ tenant_id: group.tenant_id, invoice_id: group.invoice_id, ...result })}\n`,
      );
    }
    const unresolvedAfter = await unresolvedCount(ownerPool);
    const remainingGroups = await duplicateGroups(ownerPool);
    process.stdout.write(`superseded=${superseded}\n`);
    process.stdout.write(`unresolved_after=${unresolvedAfter}\n`);
    process.stdout.write(`duplicate_groups_after=${remainingGroups.length}\n`);
    if (remainingGroups.length > 0) {
      throw new Error("duplicate Collections proposal groups remain after guarded cleanup");
    }
  } finally {
    await Promise.all([appPool.end(), ownerPool.end()]);
  }
}

void main();
