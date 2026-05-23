/**
 * agent_findings + agent_finding_overrides repository (Agent Autonomy v3, 2.6).
 * Tenant-scoped. High-risk agents (Vendor Risk, Compliance) emit a finding before
 * any block/confirm; blocks can be overridden-and-documented by a tenant-root
 * operator. Compliance findings are recorded even when the resolved mode is
 * notify_only — they must be persistent.
 */

import type { TenantScopedClient } from "@brain/shared";

export type FindingSeverity = "low" | "medium" | "high" | "critical";
export type FindingStatus = "open" | "overridden" | "resolved";

export interface AgentFindingRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  finding_kind: string;
  severity: FindingSeverity;
  rule_id: string | null;
  rule_catalog_version: string | null;
  subject_type: string | null;
  subject_id: string | null;
  detail: Record<string, unknown>;
  status: FindingStatus;
  created_at: Date;
}

export interface InsertFindingInput {
  id: string;
  tenantId: string;
  agentId: string;
  findingKind: string;
  severity: FindingSeverity;
  ruleId?: string | null;
  ruleCatalogVersion?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  detail?: Record<string, unknown>;
}

export async function insertFinding(
  client: TenantScopedClient,
  input: InsertFindingInput,
): Promise<AgentFindingRow> {
  const { rows } = await client.query<AgentFindingRow>(
    `INSERT INTO agent_findings
       (id, tenant_id, agent_id, finding_kind, severity, rule_id, rule_catalog_version,
        subject_type, subject_id, detail, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open') RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.agentId,
      input.findingKind,
      input.severity,
      input.ruleId ?? null,
      input.ruleCatalogVersion ?? null,
      input.subjectType ?? null,
      input.subjectId ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("agent_findings insert returned no row");
  return row;
}

export async function listFindingsByAgent(
  client: TenantScopedClient,
  agentId: string,
  limit = 100,
): Promise<AgentFindingRow[]> {
  const { rows } = await client.query<AgentFindingRow>(
    `SELECT * FROM agent_findings WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows;
}

export interface AgentFindingOverrideRow {
  id: string;
  tenant_id: string;
  finding_id: string;
  agent_id: string;
  overridden_by: string;
  reason: string;
  created_at: Date;
}

/**
 * Record a tenant-root override of a finding's block, with the mandatory stated
 * reason, and flip the finding to `overridden`. Both happen in one tx.
 */
export async function insertFindingOverride(
  client: TenantScopedClient,
  input: {
    id: string;
    tenantId: string;
    findingId: string;
    agentId: string;
    overriddenBy: string;
    reason: string;
  },
): Promise<AgentFindingOverrideRow> {
  const { rows } = await client.query<AgentFindingOverrideRow>(
    `INSERT INTO agent_finding_overrides
       (id, tenant_id, finding_id, agent_id, overridden_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.id, input.tenantId, input.findingId, input.agentId, input.overriddenBy, input.reason],
  );
  await client.query(`UPDATE agent_findings SET status = 'overridden' WHERE id = $1`, [
    input.findingId,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error("agent_finding_overrides insert returned no row");
  return row;
}

/** Override history for an agent — subsequent runs read this. */
export async function listOverridesByAgent(
  client: TenantScopedClient,
  agentId: string,
  limit = 100,
): Promise<AgentFindingOverrideRow[]> {
  const { rows } = await client.query<AgentFindingOverrideRow>(
    `SELECT * FROM agent_finding_overrides WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows;
}
