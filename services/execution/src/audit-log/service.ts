import { randomUUID } from "node:crypto";
import {
  brainError,
  withTenantScope,
  type AuditEmitter,
  type AuditEvent,
  type BlobAdapter,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import { insertProposalSnapshot } from "../proposal-snapshots/service.js";

export const DECISION_AUDIT_ACTIONS = [
  "decision.executed",
  "decision.proposed",
  "decision.auto_executed",
  "decision.escalated",
] as const;

export interface DecisionAuditLogEntry {
  id: string;
  tenant_id: string;
  occurred_at: string;
  actor: DecisionAuditActor;
  proposal_id: string;
  agent: string;
  decision: string;
  outcome: Record<string, unknown>;
  policy_context: Record<string, unknown>;
  payload_snapshot_id: string;
  event_id: string;
  event_action: string;
  archived_at: string | null;
  cold_storage_uri: string | null;
  created_at: string;
}

export interface DecisionAuditActor {
  type: "user" | "system" | "agent";
  id: string;
  display_name: string | null;
}

export interface AuditLogFilters {
  from?: string;
  to?: string;
  actor_type?: "user" | "system" | "agent";
  agent?: string;
  decision?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditLogListResult {
  entries: DecisionAuditLogEntry[];
  next_cursor: string | null;
}

export interface AuditLogExportResult {
  url: string;
  path: string;
  count: number;
}

export class DecisionAuditLogService {
  public constructor(
    private readonly pool: Pool,
    private readonly blob?: BlobAdapter,
  ) {}

  public async consume(event: AuditEvent): Promise<void> {
    if (!isDecisionAuditAction(event.action)) return;
    await withTenantScope(this.pool, event.tenantId, async (client) => {
      if (await hasEvent(client, event.id)) return;
      const payload = payloadSnapshotFor(event);
      const snapshot = await insertProposalSnapshot(
        client,
        {
          tenantId: event.tenantId,
          actor: "system:audit-log",
        },
        payload,
      );
      const entry = entryFromEvent(event, snapshot.id);
      await client.query(
        `INSERT INTO decision_audit_log (
           id, tenant_id, occurred_at, actor, proposal_id, agent, decision,
           outcome, policy_context, payload_snapshot_id, event_id, event_action
         )
         VALUES (
           $1, current_setting('app.tenant_id', true), $2, $3::jsonb, $4, $5, $6,
           $7::jsonb, $8::jsonb, $9, $10, $11
         )
         ON CONFLICT (tenant_id, event_id) DO NOTHING`,
        [
          entry.id,
          entry.occurred_at,
          JSON.stringify(entry.actor),
          entry.proposal_id,
          entry.agent,
          entry.decision,
          JSON.stringify(entry.outcome),
          JSON.stringify(entry.policy_context),
          entry.payload_snapshot_id,
          entry.event_id,
          entry.event_action,
        ],
      );
    });
  }

  public async list(
    ctx: ServiceCallContext,
    filters: AuditLogFilters,
  ): Promise<AuditLogListResult> {
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const limit = clampLimit(filters.limit);
      const { where, values } = buildWhere(filters);
      const cursor = decodeCursor(filters.cursor);
      if (cursor !== null) {
        values.push(cursor.occurred_at, cursor.id);
        where.push(
          `(occurred_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
        );
      }
      values.push(limit + 1);
      const { rows } = await client.query<DecisionAuditLogRow>(
        `SELECT *
           FROM decision_audit_log
          WHERE tenant_id = current_setting('app.tenant_id', true)
            ${where.length > 0 ? "AND " + where.join(" AND ") : ""}
          ORDER BY occurred_at DESC, id DESC
          LIMIT $${values.length}`,
        values,
      );
      const page = rows.slice(0, limit).map(entryFromRow);
      const last = page[page.length - 1];
      return {
        entries: page,
        next_cursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
      };
    });
  }

  public async get(ctx: ServiceCallContext, id: string): Promise<DecisionAuditLogEntry | null> {
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const { rows } = await client.query<DecisionAuditLogRow>(
        `SELECT *
           FROM decision_audit_log
          WHERE id = $1
            AND tenant_id = current_setting('app.tenant_id', true)`,
        [id],
      );
      return rows[0] === undefined ? null : entryFromRow(rows[0]);
    });
  }

  public async exportCsv(
    ctx: ServiceCallContext,
    filters: Omit<AuditLogFilters, "limit" | "cursor">,
  ): Promise<AuditLogExportResult> {
    if (this.blob === undefined) {
      throw brainError("dependency_unavailable", "audit log export storage is not configured");
    }
    const entries: DecisionAuditLogEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.list(ctx, {
        ...filters,
        limit: 500,
        ...(cursor !== null ? { cursor } : {}),
      });
      entries.push(...page.entries);
      cursor = page.next_cursor;
    } while (cursor !== null);
    const csv = toCsv(entries);
    const path = `${ctx.tenantId}/audit-log/${randomUUID()}.csv`;
    await this.blob.put(path, Buffer.from(csv, "utf8"), {
      contentType: "text/csv",
      metadata: { tenant_id: ctx.tenantId, kind: "decision_audit_log_export" },
      immutable: true,
    });
    return {
      path,
      url: await this.blob.signedUrl(path, { expiresInSeconds: 900 }),
      count: entries.length,
    };
  }

  public async archiveOlderThan(ctx: ServiceCallContext, cutoff: Date): Promise<number> {
    const entries = await this.list(ctx, { to: cutoff.toISOString(), limit: 500 });
    if (entries.entries.length === 0) return 0;
    let coldStorageUri: string | null = null;
    if (this.blob !== undefined) {
      const path = `${ctx.tenantId}/audit-log/archive/${cutoff.toISOString()}-${randomUUID()}.csv`;
      await this.blob.put(path, Buffer.from(toCsv(entries.entries), "utf8"), {
        contentType: "text/csv",
        metadata: { tenant_id: ctx.tenantId, kind: "decision_audit_log_archive" },
        immutable: true,
      });
      coldStorageUri = path;
    }
    return withTenantScope(this.pool, ctx.tenantId, async (client) => {
      const ids = entries.entries.map((entry) => entry.id);
      const { rowCount } = await client.query(
        `UPDATE decision_audit_log
            SET archived_at = now(),
                cold_storage_uri = COALESCE($2, cold_storage_uri)
          WHERE id = ANY($1::uuid[])
            AND tenant_id = current_setting('app.tenant_id', true)
            AND archived_at IS NULL`,
        [ids, coldStorageUri],
      );
      await client.query(
        `INSERT INTO decision_audit_log_archive_runs (
           id, tenant_id, cutoff, archived_count
         )
         VALUES ($1, current_setting('app.tenant_id', true), $2, $3)`,
        [randomUUID(), cutoff, rowCount ?? 0],
      );
      return rowCount ?? 0;
    });
  }
}

export class DecisionAuditLogEmitter implements AuditEmitter {
  public constructor(
    private readonly inner: AuditEmitter,
    private readonly auditLog: DecisionAuditLogService,
  ) {}

  public async emit(event: Parameters<AuditEmitter["emit"]>[0]): Promise<AuditEvent> {
    const emitted = await this.inner.emit(event);
    await this.auditLog.consume(emitted);
    return emitted;
  }
}

interface DecisionAuditLogRow {
  id: string;
  tenant_id: string;
  occurred_at: Date;
  actor: DecisionAuditActor;
  proposal_id: string;
  agent: string;
  decision: string;
  outcome: Record<string, unknown>;
  policy_context: Record<string, unknown>;
  payload_snapshot_id: string;
  event_id: string;
  event_action: string;
  archived_at: Date | null;
  cold_storage_uri: string | null;
  created_at: Date;
}

function isDecisionAuditAction(action: string): action is (typeof DECISION_AUDIT_ACTIONS)[number] {
  return (DECISION_AUDIT_ACTIONS as readonly string[]).includes(action);
}

async function hasEvent(client: TenantScopedClient, eventId: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
       FROM decision_audit_log
      WHERE event_id = $1
        AND tenant_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
    [eventId],
  );
  return rows.length > 0;
}

function payloadSnapshotFor(event: AuditEvent): Record<string, unknown> {
  return {
    event_id: event.id,
    action: event.action,
    inputs: event.inputs,
    outputs: event.outputs,
    before_state: event.beforeState ?? null,
    after_state: event.afterState ?? null,
  };
}

function entryFromEvent(event: AuditEvent, snapshotId: string): DecisionAuditLogEntry {
  const outputs = event.outputs as Record<string, unknown>;
  const inputs = event.inputs as Record<string, unknown>;
  const proposalId = readString(inputs["proposal_id"]) || readString(outputs["proposal_id"]);
  const proposalSummary = readObject(outputs["proposal_summary"]);
  const agent = readString(proposalSummary?.["proposing_agent"]) || readString(outputs["agent"]);
  const decision =
    readString(inputs["decision"]) || readString(outputs["decision"]) || event.action;
  return {
    id: randomUUID(),
    tenant_id: event.tenantId,
    occurred_at: event.createdAt,
    actor: {
      type: actorType(event.actor),
      id: event.actor,
      display_name: event.actorDisplayName ?? null,
    },
    proposal_id: proposalId,
    agent: agent.length > 0 ? agent : "unknown",
    decision,
    outcome: {
      status: readString(outputs["outcome"]) || event.outcome || "recorded",
      references: readArray(outputs["outbound_reference_ids"]),
      adapter_calls: readArray(outputs["adapter_calls"]),
      details: readObject(outputs["details"]) ?? {},
      proposal_summary: proposalSummary ?? {},
    },
    policy_context: {
      authority_at_time: readString(outputs["authority_at_time"], "propose"),
      rule_id_if_any:
        readString(outputs["rule_id_if_any"]) ||
        readString(inputs["rule_id"]) ||
        event.policyCheckId ||
        null,
    },
    payload_snapshot_id: snapshotId,
    event_id: event.id,
    event_action: event.action,
    archived_at: null,
    cold_storage_uri: null,
    created_at: new Date().toISOString(),
  };
}

function entryFromRow(row: DecisionAuditLogRow): DecisionAuditLogEntry {
  return {
    ...row,
    occurred_at: row.occurred_at.toISOString(),
    archived_at: row.archived_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

function actorType(actor: string): DecisionAuditActor["type"] {
  if (actor.startsWith("system:")) return "system";
  if (actor.startsWith("agent_")) return "agent";
  return "user";
}

function buildWhere(filters: AuditLogFilters): { where: string[]; values: unknown[] } {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.from !== undefined) {
    values.push(filters.from);
    where.push(`occurred_at >= $${values.length}::timestamptz`);
  }
  if (filters.to !== undefined) {
    values.push(filters.to);
    where.push(`occurred_at <= $${values.length}::timestamptz`);
  }
  if (filters.actor_type !== undefined) {
    values.push(filters.actor_type);
    where.push(`actor->>'type' = $${values.length}`);
  }
  if (filters.agent !== undefined) {
    values.push(filters.agent);
    where.push(`agent = $${values.length}`);
  }
  if (filters.decision !== undefined) {
    values.push(filters.decision);
    where.push(`decision = $${values.length}`);
  }
  return { where, values };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw brainError("request_body_invalid", "limit must be between 1 and 500");
  }
  return limit;
}

function encodeCursor(entry: DecisionAuditLogEntry): string {
  return Buffer.from(JSON.stringify({ occurred_at: entry.occurred_at, id: entry.id })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | undefined): { occurred_at: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      occurred_at?: unknown;
      id?: unknown;
    };
    if (typeof parsed.occurred_at === "string" && typeof parsed.id === "string") {
      return { occurred_at: parsed.occurred_at, id: parsed.id };
    }
  } catch {
    throw brainError("request_body_invalid", "invalid cursor");
  }
  throw brainError("request_body_invalid", "invalid cursor");
}

function toCsv(entries: readonly DecisionAuditLogEntry[]): string {
  const header = [
    "id",
    "occurred_at",
    "actor_type",
    "actor_id",
    "proposal_id",
    "agent",
    "decision",
    "status",
    "payload_snapshot_id",
  ];
  const rows = entries.map((entry) => [
    entry.id,
    entry.occurred_at,
    entry.actor.type,
    entry.actor.id,
    entry.proposal_id,
    entry.agent,
    entry.decision,
    readString(entry.outcome["status"]),
    entry.payload_snapshot_id,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
