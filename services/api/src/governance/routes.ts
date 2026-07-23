import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  brainError,
  decodeKeysetCursor,
  encodeKeysetCursor,
  parseDateParam,
  parsePositiveIntParam,
  withTenantScope,
  type AuditEmitter,
  type TenantScopedClient,
} from "@brain/shared";
import { assertAgentTransition, type AgentState } from "@brain/execution";
import { assertPlatformCredential } from "../production-tenancy/routes.js";

export interface GovernanceRoutesDeps {
  pool: Pool;
  audit: AuditEmitter;
  platformSecret?: string;
}

interface AgentRow {
  id: string;
  tenant_id: string;
  kind: "internal" | "external";
  role: string;
  display_name: string;
  scope_hash: Buffer | null;
  onchain_address: string | null;
  state: AgentState;
  registered_tx: string | null;
  registered_at: Date | null;
  created_at: Date;
}

interface AuditTimelineRow {
  id: string;
  actor: string;
  action: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  policy_decision_id: string | null;
  policy_check_id: string | null;
  outcome: string | null;
  created_at: Date;
}

interface ReportRow extends AuditTimelineRow {
  native_outcome: string | null;
  native_policy_check_id: string | null;
  joined_policy_decision_id: string | null;
  joined_outcome: "allow" | "confirm" | "reject" | null;
  joined_policy_check_id: string | null;
}

const GOVERNANCE_READ = "governance:read";
const REPORT_LIMIT = 1000;

export async function registerGovernanceRoutes(
  app: FastifyInstance,
  deps: GovernanceRoutesDeps,
): Promise<void> {
  app.get(
    "/governance/agents",
    { config: { skipAuth: true } },
    async (
      request: FastifyRequest<{
        Querystring: {
          tenant_id?: string;
          status?: string;
          owner?: string;
          limit?: string;
          cursor?: string;
        };
      }>,
    ) => {
      assertPlatformCredential(request, deps.platformSecret, GOVERNANCE_READ);
      const tenantId = requireTenantId(request.query.tenant_id);
      const limit = parsePositiveIntParam("limit", request.query.limit, {
        fallback: 100,
        max: 500,
      });
      if (request.query.owner !== undefined && request.query.owner !== tenantId) {
        return { agents: [], next_cursor: null };
      }
      const cursor =
        request.query.cursor !== undefined ? decodeKeysetCursor(request.query.cursor) : undefined;
      const rows = await withTenantScope(deps.pool, tenantId, (client) =>
        listGovernanceAgents(client, {
          limit: limit + 1,
          ...(request.query.status !== undefined ? { status: request.query.status } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      );
      const visible = rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        agents: visible.map(serializeAgent),
        next_cursor:
          rows.length > limit && last !== undefined
            ? encodeKeysetCursor({ sort: last.created_at.toISOString(), id: last.id })
            : null,
      };
    },
  );

  app.get(
    "/governance/agents/:agent_id",
    { config: { skipAuth: true } },
    async (
      request: FastifyRequest<{
        Params: { agent_id: string };
        Querystring: { tenant_id?: string };
      }>,
    ) => {
      assertPlatformCredential(request, deps.platformSecret, GOVERNANCE_READ);
      const tenantId = requireTenantId(request.query.tenant_id);
      const result = await withTenantScope(deps.pool, tenantId, async (client) => {
        const agent = await findGovernanceAgent(client, request.params.agent_id);
        if (agent === null) return null;
        const timeline = await listAgentTimeline(client, request.params.agent_id);
        return { agent, timeline };
      });
      if (result === null) {
        throw brainError("agent_not_found", "agent not found", { statusOverride: 404 });
      }
      return {
        agent: {
          ...serializeAgent(result.agent),
          lifecycle_events: result.timeline.map(serializeTimelineEvent),
        },
      };
    },
  );

  app.patch(
    "/governance/agents/:agent_id",
    { config: { skipAuth: true } },
    async (
      request: FastifyRequest<{
        Params: { agent_id: string };
        Body?: { tenant_id?: unknown; transition?: unknown; reason?: unknown; actor?: unknown };
      }>,
      reply,
    ) => {
      assertPlatformCredential(request, deps.platformSecret, GOVERNANCE_READ);
      const body = request.body ?? {};
      const tenantId = requireTenantId(body.tenant_id);
      const transition = requireTransition(body.transition);
      const reason = requireString(body.reason, "reason");
      const actor = requireString(body.actor, "actor");
      const result = await withTenantScope(deps.pool, tenantId, async (client) => {
        const before = await findGovernanceAgent(client, request.params.agent_id);
        if (before === null) return null;
        const afterState = transitionTarget(before.state, transition);
        assertAgentTransition(before.state, afterState);
        const after = await updateAgentState(
          client,
          request.params.agent_id,
          before.state,
          afterState,
        );
        return { before, after };
      });
      if (result === null) {
        throw brainError("agent_not_found", "agent not found", { statusOverride: 404 });
      }
      await deps.audit.emit({
        tenantId,
        layer: "agent",
        actor,
        action: "governance.agent.lifecycle_changed",
        inputs: {
          agent_id: request.params.agent_id,
          transition,
          reason,
          before_state: result.before.state,
        },
        outputs: { after_state: result.after.state },
      });
      reply.status(200);
      return { agent: serializeAgent(result.after) };
    },
  );

  app.get(
    "/governance/reports",
    { config: { skipAuth: true } },
    async (
      request: FastifyRequest<{
        Querystring: {
          tenant_id?: string;
          period_start?: string;
          period_end?: string;
          agent_id?: string;
          format?: string;
        };
      }>,
      reply,
    ) => {
      assertPlatformCredential(request, deps.platformSecret, GOVERNANCE_READ);
      const tenantId = requireTenantId(request.query.tenant_id);
      const periodStart = requireDate("period_start", request.query.period_start);
      const periodEnd = requireDate("period_end", request.query.period_end);
      if (periodEnd.getTime() <= periodStart.getTime()) {
        throw brainError("request_params_invalid", "period_end must be after period_start");
      }
      const format = request.query.format ?? "json";
      if (format !== "json" && format !== "csv") {
        throw brainError("request_params_invalid", "format must be json or csv");
      }
      const rows = await withTenantScope(deps.pool, tenantId, (client) =>
        queryReportEvents(client, {
          periodStart,
          periodEnd,
          ...(request.query.agent_id !== undefined ? { agentId: request.query.agent_id } : {}),
        }),
      );
      const report = buildReport(tenantId, periodStart, periodEnd, rows);
      if (format === "csv") {
        reply.type("text/csv");
        return renderReportCsv(report.events);
      }
      return report;
    },
  );
}

function requireTenantId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw brainError("request_params_invalid", "tenant_id is required");
  }
  return value;
}

function requireDate(name: string, value: string | undefined): Date {
  const parsed = parseDateParam(name, value);
  if (parsed === undefined) {
    throw brainError("request_params_invalid", `${name} is required`);
  }
  return parsed;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw brainError("request_body_invalid", `${name} is required`);
  }
  return value.trim();
}

type GovernanceTransition = "pause" | "resume" | "revoke";

function requireTransition(value: unknown): GovernanceTransition {
  if (value === "pause" || value === "resume" || value === "revoke") return value;
  throw brainError("request_body_invalid", "transition must be pause, resume, or revoke");
}

function transitionTarget(current: AgentState, transition: GovernanceTransition): AgentState {
  if (transition === "pause") return "quarantined";
  if (transition === "resume") return "active";
  if (current === "quarantined" || current === "active") return "revoked";
  return "revoked";
}

async function listGovernanceAgents(
  client: TenantScopedClient,
  filters: { limit: number; status?: string; cursor?: { sort: string; id: string } },
): Promise<AgentRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.status !== undefined) {
    values.push(filters.status);
    where.push(`state = $${values.length}`);
  }
  if (filters.cursor !== undefined) {
    values.push(filters.cursor.sort, filters.cursor.id);
    where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  values.push(filters.limit);
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<AgentRow>(
    `SELECT * FROM agents ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}

async function findGovernanceAgent(
  client: TenantScopedClient,
  agentId: string,
): Promise<AgentRow | null> {
  const { rows } = await client.query<AgentRow>(`SELECT * FROM agents WHERE id = $1 LIMIT 1`, [
    agentId,
  ]);
  return rows[0] ?? null;
}

async function updateAgentState(
  client: TenantScopedClient,
  agentId: string,
  from: AgentState,
  to: AgentState,
): Promise<AgentRow> {
  const { rows } = await client.query<AgentRow>(
    `UPDATE agents
        SET state = $1, registered_at = CASE WHEN $1 = 'active' THEN now() ELSE registered_at END
      WHERE id = $2 AND state = $3
      RETURNING *`,
    [to, agentId, from],
  );
  const row = rows[0];
  if (row === undefined) {
    throw brainError("execution_agent_not_registered", `agent ${agentId} moved during transition`);
  }
  return row;
}

async function listAgentTimeline(
  client: TenantScopedClient,
  agentId: string,
): Promise<AuditTimelineRow[]> {
  const { rows } = await client.query<AuditTimelineRow>(
    `SELECT id, actor, action, inputs, outputs, policy_decision_id, policy_check_id, outcome, created_at
       FROM audit_events
      WHERE actor = $1
         OR inputs->>'agent_id' = $1
         OR outputs->>'agent_id' = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 200`,
    [agentId],
  );
  return rows;
}

async function queryReportEvents(
  client: TenantScopedClient,
  filters: { periodStart: Date; periodEnd: Date; agentId?: string },
): Promise<ReportRow[]> {
  const values: unknown[] = [filters.periodStart, filters.periodEnd];
  const agentPredicate =
    filters.agentId === undefined
      ? ""
      : `AND (ae.actor = $3 OR ae.inputs->>'agent_id' = $3 OR ae.outputs->>'agent_id' = $3)`;
  if (filters.agentId !== undefined) values.push(filters.agentId);
  const { rows } = await client.query<ReportRow>(
    `SELECT ae.id, ae.actor, ae.action, ae.inputs, ae.outputs,
            ae.policy_decision_id, ae.policy_check_id, ae.outcome,
            ae.policy_check_id AS native_policy_check_id,
            ae.outcome AS native_outcome,
            ae.created_at,
            pd.id AS joined_policy_decision_id,
            pd.outcome AS joined_outcome,
            pd.matched_rule_id AS joined_policy_check_id
       FROM audit_events ae
       LEFT JOIN policy_decisions pd
         ON pd.id = ae.policy_decision_id
        AND pd.tenant_id = current_setting('app.tenant_id', true)
      WHERE ae.created_at >= $1
        AND ae.created_at < $2
        AND (
          ae.policy_decision_id IS NOT NULL
          OR ae.outcome IS NOT NULL
          OR ae.action IN (
            'policy.evaluate',
            'agent.action.proposed',
            'payment_intent.execute.before',
            'payment_intent.resume.gate_failed'
          )
        )
        ${agentPredicate}
      ORDER BY ae.created_at ASC, ae.id ASC
      LIMIT ${REPORT_LIMIT}`,
    values,
  );
  return rows;
}

function serializeAgent(row: AgentRow): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: row.kind,
    role: row.role,
    display_name: row.display_name,
    status: row.state,
    scopes: null,
    scope_hash: row.scope_hash !== null ? row.scope_hash.toString("hex") : null,
    onchain_address: row.onchain_address,
    registered_tx: row.registered_tx,
    registered_at: row.registered_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

function serializeTimelineEvent(row: AuditTimelineRow): Record<string, unknown> {
  return {
    audit_event_id: row.id,
    actor: row.actor,
    action: row.action,
    policy_decision_id: row.policy_decision_id,
    policy_check_id: row.policy_check_id,
    outcome: row.outcome,
    created_at: row.created_at.toISOString(),
    inputs: row.inputs,
    outputs: row.outputs,
  };
}

function buildReport(tenantId: string, periodStart: Date, periodEnd: Date, rows: ReportRow[]) {
  const events = rows.map(serializeReportEvent);
  const totals = {
    proposed: events.length,
    approved: events.filter((e) => e.outcome === "approved").length,
    blocked: events.filter((e) => e.outcome === "blocked").length,
    escalated: events.filter((e) => e.outcome === "escalated").length,
    decision_data_unavailable: events.filter((e) => e.decision_data_status === "unavailable")
      .length,
  };
  return {
    tenant_id: tenantId,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    summary: {
      totals,
      coverage: {
        events: events.length,
        with_policy_decision_id: rows.filter((r) => r.policy_decision_id !== null).length,
        joined_policy_decision: rows.filter((r) => r.joined_policy_decision_id !== null).length,
        with_native_outcome: rows.filter((r) => r.native_outcome !== null).length,
      },
    },
    events,
  };
}

function serializeReportEvent(row: ReportRow) {
  const rawOutcome =
    row.native_outcome ?? row.joined_outcome ?? stringFromRecord(row.outputs, "outcome");
  const policyCheckId = row.native_policy_check_id ?? row.joined_policy_check_id;
  const available = rawOutcome !== undefined && rawOutcome !== null;
  return {
    audit_event_id: row.id,
    created_at: row.created_at.toISOString(),
    actor: row.actor,
    agent_id: resolveAgentId(row),
    action: row.action,
    policy_decision_id: row.policy_decision_id,
    policy_check_id: policyCheckId,
    raw_policy_outcome: rawOutcome ?? null,
    outcome: available ? mapOutcome(rawOutcome) : null,
    decision_data_status: available ? "available" : "unavailable",
    unavailable_reason: available
      ? null
      : row.policy_decision_id === null
        ? "policy_decision_id_missing"
        : "policy_decision_join_missing",
  };
}

function resolveAgentId(row: ReportRow): string | null {
  if (row.actor.startsWith("agent_")) return row.actor;
  return (
    stringFromRecord(row.inputs, "agent_id") ?? stringFromRecord(row.outputs, "agent_id") ?? null
  );
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapOutcome(outcome: string): "approved" | "blocked" | "escalated" {
  if (outcome === "reject" || outcome === "blocked" || outcome === "rejected") return "blocked";
  if (outcome === "confirm" || outcome === "escalated" || outcome === "pending") return "escalated";
  return "approved";
}

function renderReportCsv(events: ReturnType<typeof serializeReportEvent>[]): string {
  const header = [
    "audit_event_id",
    "created_at",
    "actor",
    "agent_id",
    "action",
    "policy_decision_id",
    "policy_check_id",
    "raw_policy_outcome",
    "outcome",
    "decision_data_status",
    "unavailable_reason",
  ];
  return [
    header.join(","),
    ...events.map((event) =>
      header.map((key) => csvCell(event[key as keyof typeof event])).join(","),
    ),
  ].join("\n");
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  return /[",\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}
