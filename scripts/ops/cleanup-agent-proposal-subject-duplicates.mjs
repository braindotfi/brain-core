/**
 * Repair historical duplicate pending proposals for agent types that use the
 * subject-key refresh path in AgentService.propose(). Collections is excluded:
 * it has a dedicated invoice cleanup operation.
 *
 * Default mode is read-only. `--apply` keeps the newest pending proposal for
 * each (tenant, agent, subject field, subject value), supersedes older rows,
 * and writes an append-only audit event for every superseded proposal.
 */

import { parseArgs } from "node:util";
import { Pool } from "pg";
import { PostgresAuditEmitter } from "@brain/shared";

const AGENT_PROPOSAL_LOCK_NAMESPACE = 0x41474e54; // "AGNT"
const REPORT_STATEMENT_TIMEOUT = "60s";

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
    process.stdout.write("Usage: cleanup-agent-proposal-subject-duplicates [--apply]\n");
    process.exit(0);
  }
  return { apply: values.apply === true };
}

const subjectCte = `
  WITH scoped AS (
    SELECT p.tenant_id,
           p.proposing_agent,
           p.id,
           p.created_at,
           p.action,
           CASE
             WHEN p.proposing_agent = 'vendor_risk'
                  AND NULLIF(p.action->>'vendor_id', '') IS NOT NULL THEN 'vendor_id'
             WHEN p.proposing_agent = 'vendor_risk'
                  AND NULLIF(p.action->>'counterparty_id', '') IS NOT NULL THEN 'counterparty_id'
             WHEN p.proposing_agent IN ('subscription', 'fraud_anomaly')
                  AND NULLIF(p.action->>'transaction_id', '') IS NOT NULL THEN 'transaction_id'
             WHEN p.proposing_agent = 'compliance'
                  AND NULLIF(p.action->>'policy_decision_id', '') IS NOT NULL THEN 'policy_decision_id'
             WHEN p.proposing_agent = 'compliance'
                  AND NULLIF(p.action->>'audit_event_id', '') IS NOT NULL THEN 'audit_event_id'
             ELSE NULL
           END AS subject_field,
           CASE
             WHEN p.proposing_agent = 'vendor_risk'
                  AND NULLIF(p.action->>'vendor_id', '') IS NOT NULL THEN p.action->>'vendor_id'
             WHEN p.proposing_agent = 'vendor_risk'
                  AND NULLIF(p.action->>'counterparty_id', '') IS NOT NULL THEN p.action->>'counterparty_id'
             WHEN p.proposing_agent IN ('subscription', 'fraud_anomaly')
                  AND NULLIF(p.action->>'transaction_id', '') IS NOT NULL THEN p.action->>'transaction_id'
             WHEN p.proposing_agent = 'compliance'
                  AND NULLIF(p.action->>'policy_decision_id', '') IS NOT NULL THEN p.action->>'policy_decision_id'
             WHEN p.proposing_agent = 'compliance'
                  AND NULLIF(p.action->>'audit_event_id', '') IS NOT NULL THEN p.action->>'audit_event_id'
             ELSE NULL
           END AS subject_value
      FROM proposals p
     WHERE p.status = 'pending'
       AND p.proposing_agent IN ('vendor_risk', 'subscription', 'fraud_anomaly', 'compliance')
  ), eligible AS (
    SELECT *
      FROM scoped
     WHERE subject_field IS NOT NULL
       AND subject_value IS NOT NULL
  ), ranked AS (
    SELECT *,
           row_number() OVER (
             PARTITION BY tenant_id, proposing_agent, subject_field, subject_value
             ORDER BY created_at DESC, id DESC
           ) AS position,
           count(*) OVER (
             PARTITION BY tenant_id, proposing_agent, subject_field, subject_value
           ) AS group_size
      FROM eligible
  )`;

async function inReadOnlyTransaction(pool, fn) {
  await pool.query("BEGIN TRANSACTION READ ONLY");
  try {
    // The full historical report ranks every pending eligible row. It is
    // read-only and bounded by the workflow timeout, but needs headroom for
    // the production backlog rather than failing at the old 10 second budget.
    await pool.query(`SET LOCAL statement_timeout = '${REPORT_STATEMENT_TIMEOUT}'`);
    await pool.query("SET LOCAL lock_timeout = '1s'");
    const result = await fn();
    await pool.query("COMMIT");
    return result;
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function duplicateGroups(pool) {
  return inReadOnlyTransaction(pool, async () => {
    const { rows } = await pool.query(
      `${subjectCte}
       SELECT tenant_id,
              proposing_agent,
              subject_field,
              subject_value,
              max(group_size)::int AS unresolved_count,
              max(id) FILTER (WHERE position = 1) AS keep_proposal_id,
              array_agg(id ORDER BY created_at DESC, id DESC) FILTER (WHERE position > 1)
                AS supersede_proposal_ids
         FROM ranked
        WHERE group_size > 1
        GROUP BY tenant_id, proposing_agent, subject_field, subject_value
        ORDER BY tenant_id, proposing_agent, subject_field, subject_value`,
    );
    return rows;
  });
}

async function reportEvidence(pool) {
  return inReadOnlyTransaction(pool, async () => {
    const { rows } = await pool.query(
      `${subjectCte}
       SELECT (SELECT count(*)::int FROM scoped) AS agent_pending_rows,
              (SELECT count(*)::int FROM eligible) AS subject_eligible_pending_rows,
              (SELECT count(*)::int FROM scoped WHERE subject_field IS NULL)
                AS pending_rows_without_stable_subject,
              (SELECT count(DISTINCT tenant_id)::int FROM eligible) AS tenant_count,
              (SELECT count(*)::int
                 FROM (SELECT DISTINCT tenant_id, proposing_agent, subject_field, subject_value
                         FROM eligible) groups) AS distinct_subject_groups,
              (SELECT count(*)::int
                 FROM (SELECT DISTINCT tenant_id, proposing_agent, subject_field, subject_value
                         FROM ranked WHERE group_size > 1) groups) AS duplicate_groups,
              (SELECT coalesce(sum(group_size - 1), 0)::int
                 FROM (SELECT DISTINCT tenant_id, proposing_agent, subject_field, subject_value, group_size
                         FROM ranked WHERE group_size > 1) groups) AS rows_to_supersede,
              (SELECT min(created_at) FROM ranked WHERE group_size > 1) AS duplicate_oldest_created_at,
              (SELECT max(created_at) FROM ranked WHERE group_size > 1) AS duplicate_newest_created_at`,
    );
    const { rows: perAgentRows } = await pool.query(
      `${subjectCte}
       SELECT proposing_agent,
              count(*)::int AS subject_eligible_pending_rows,
              count(DISTINCT concat_ws(':', tenant_id, subject_field, subject_value))::int
                AS distinct_subject_groups,
              count(DISTINCT concat_ws(':', tenant_id, subject_field, subject_value))
                FILTER (WHERE group_size > 1)::int AS duplicate_groups,
              coalesce(sum(group_size - 1) FILTER (WHERE position = 1 AND group_size > 1), 0)::int
                AS rows_to_supersede
         FROM ranked
        GROUP BY proposing_agent
        ORDER BY proposing_agent`,
    );
    const { rows: largestGroupRows } = await pool.query(
      `${subjectCte}
       SELECT tenant_id,
              proposing_agent,
              subject_field,
              subject_value,
              id AS proposal_id,
              created_at,
              position,
              group_size,
              action
         FROM ranked
        WHERE (tenant_id, proposing_agent, subject_field, subject_value) = (
          SELECT tenant_id, proposing_agent, subject_field, subject_value
            FROM ranked
           WHERE group_size > 1
           ORDER BY group_size DESC, tenant_id, proposing_agent, subject_field, subject_value
           LIMIT 1
        )
        ORDER BY created_at ASC, id ASC`,
    );
    return {
      summary: rows[0] ?? {},
      per_agent: perAgentRows,
      largest_group_rows: largestGroupRows,
    };
  });
}

function subjectPredicate(group) {
  const field = group.subject_field;
  if (
    (group.proposing_agent === "vendor_risk" && (field === "vendor_id" || field === "counterparty_id")) ||
    ((group.proposing_agent === "subscription" || group.proposing_agent === "fraud_anomaly") &&
      field === "transaction_id") ||
    (group.proposing_agent === "compliance" &&
      (field === "policy_decision_id" || field === "audit_event_id"))
  ) {
    const fallback =
      (group.proposing_agent === "vendor_risk" && field === "counterparty_id") ||
      (group.proposing_agent === "compliance" && field === "audit_event_id");
    return {
      field,
      fallback,
      sql: fallback
        ? `NULLIF(action->>'${field}', '') = $2 AND NULLIF(action->>'${
            group.proposing_agent === "vendor_risk" ? "vendor_id" : "policy_decision_id"
          }', '') IS NULL`
        : `NULLIF(action->>'${field}', '') = $2`,
    };
  }
  throw new Error(`unsupported agent subject group: ${group.proposing_agent}.${field}`);
}

async function supersedeGroup(appPool, audit, group) {
  const client = await appPool.connect();
  try {
    const predicate = subjectPredicate(group);
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [group.tenant_id]);
    await client.query(
      `SELECT pg_advisory_xact_lock(${AGENT_PROPOSAL_LOCK_NAMESPACE}, hashtext($1))`,
      [`${group.tenant_id}:${group.proposing_agent}:${predicate.field}:${group.subject_value}`],
    );
    const { rows } = await client.query(
      `SELECT id, action, status
         FROM proposals
        WHERE proposing_agent = $1
          AND status = 'pending'
          AND ${predicate.sql}
        ORDER BY created_at DESC, id DESC
        FOR UPDATE`,
      [group.proposing_agent, group.subject_value],
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
        actor: "agent_proposal_subject_duplicate_cleanup",
        action: "agent.action.superseded",
        inputs: {
          proposal_id: duplicate.id,
          proposing_agent: group.proposing_agent,
          [predicate.field]: group.subject_value,
          retained_proposal_id: current.id,
        },
        outputs: {
          status: "superseded",
          reason: "duplicate_unresolved_agent_subject_proposal",
        },
        beforeState: { id: duplicate.id, status: duplicate.status, action: duplicate.action },
        afterState: { id: duplicate.id, status: "superseded", superseded_by: current.id },
        idempotencyKey: `agent-subject-duplicate-cleanup:${duplicate.id}:${current.id}`,
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
  const ownerPool = new Pool({
    connectionString: `postgres://brain:${encodeURIComponent(
      requireEnv("POSTGRES_PASSWORD"),
    )}@postgres:5432/brain`,
  });
  const audit = new PostgresAuditEmitter(appPool);
  try {
    const groups = await duplicateGroups(ownerPool);
    const evidence = await reportEvidence(ownerPool);
    const proposalsToSupersede = groups.reduce(
      (count, group) => count + group.supersede_proposal_ids.length,
      0,
    );
    process.stdout.write(`mode=${apply ? "apply" : "report"}\n`);
    process.stdout.write(`duplicate_groups=${groups.length}\n`);
    process.stdout.write(`proposals_to_supersede=${proposalsToSupersede}\n`);
    process.stdout.write(`report_evidence=${JSON.stringify(evidence)}\n`);
    for (const group of groups) process.stdout.write(`${JSON.stringify(group)}\n`);

    if (!apply) return;

    let superseded = 0;
    for (const group of groups) {
      const result = await supersedeGroup(appPool, audit, group);
      superseded += result.superseded.length;
      process.stdout.write(`${JSON.stringify({ ...group, ...result })}\n`);
    }
    const remainingGroups = await duplicateGroups(ownerPool);
    process.stdout.write(`superseded=${superseded}\n`);
    process.stdout.write(`duplicate_groups_after=${remainingGroups.length}\n`);
    if (remainingGroups.length > 0) {
      throw new Error("duplicate agent proposal subject groups remain after guarded cleanup");
    }
  } finally {
    await Promise.all([appPool.end(), ownerPool.end()]);
  }
}

void main();
