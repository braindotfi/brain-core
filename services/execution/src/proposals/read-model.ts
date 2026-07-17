import { Buffer } from "node:buffer";
import {
  brainError,
  isBrainId,
  withTenantScope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";

export const PROPOSAL_TYPES = [
  "vendor_risk",
  "payment",
  "collections",
  "treasury",
  "cash_forecast",
  "dispute",
  "compliance",
  "revenue_intel",
  "reconciliation",
  "subscription",
  "fraud_anomaly",
] as const;

export type ProposalType = (typeof PROPOSAL_TYPES)[number];
export type ProposalRiskBand = "low" | "standard" | "elevated" | "high";
export type ProposalMode = "propose" | "notify_only";

const PROPOSAL_TYPE_SET: ReadonlySet<string> = new Set(PROPOSAL_TYPES);
const RISK_BANDS = ["low", "standard", "elevated", "high"] as const;
const RISK_BAND_SET: ReadonlySet<string> = new Set(RISK_BANDS);
const STATUSES = [
  "proposed",
  "pending",
  "pending_approval",
  "awaiting_second_approval",
  "approved",
  "paused",
  "dispatching",
  "rejected",
  "executed",
  "failed",
  "cancelled",
] as const;
const STATUS_SET: ReadonlySet<string> = new Set(STATUSES);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface ProposalAgentRef {
  id: string;
  kind: string;
  display_name: string;
}

export interface ProposalEvidenceRef {
  id: string;
  type: "wiki_entity";
}

export interface ProposalReadItem {
  id: string;
  type: ProposalType;
  created_at: string;
  status: string;
  risk_band: ProposalRiskBand | null;
  confidence: number | null;
  mode: ProposalMode;
  narrative: string | null;
  evidence: ProposalEvidenceRef[];
  agent: ProposalAgentRef | null;
  payment_intent_id: string | null;
  action_type: string | null;
}

export interface ListProposalsInput {
  type?: ProposalType;
  status?: string;
  risk_band?: ProposalRiskBand;
  min_confidence?: number;
  limit?: number;
  cursor?: string;
}

export interface ListProposalsResult {
  proposals: ProposalReadItem[];
  next_cursor: string | null;
}

interface ProposalCursor {
  created_at: string;
  id: string;
}

interface RawProposalRow {
  id: string;
  source_kind: "payment_intent" | "proposal";
  type: ProposalType | null;
  created_at: Date | string;
  status: string;
  risk_band: ProposalRiskBand | null;
  confidence: number | string | null;
  mode: ProposalMode;
  narrative: string | null;
  action: Record<string, unknown> | null;
  evidence_ids: string[] | null;
  agent_id: string | null;
  agent_kind: string | null;
  agent_display_name: string | null;
  payment_intent_id: string | null;
  action_type: string | null;
}

export function parseListProposalsQuery(query: {
  type?: string;
  status?: string;
  risk_band?: string;
  min_confidence?: string;
  limit?: string;
  cursor?: string;
}): ListProposalsInput {
  const result: ListProposalsInput = {};
  if (query.type !== undefined) {
    if (!PROPOSAL_TYPE_SET.has(query.type)) {
      throw brainError("request_params_invalid", `unknown proposal type: ${query.type}`);
    }
    result.type = query.type as ProposalType;
  }
  if (query.status !== undefined) {
    if (!STATUS_SET.has(query.status)) {
      throw brainError("request_params_invalid", `unknown proposal status: ${query.status}`);
    }
    result.status = query.status;
  }
  if (query.risk_band !== undefined) {
    if (!RISK_BAND_SET.has(query.risk_band)) {
      throw brainError("request_params_invalid", `unknown risk_band: ${query.risk_band}`);
    }
    result.risk_band = query.risk_band as ProposalRiskBand;
  }
  if (query.min_confidence !== undefined) {
    const parsed = Number(query.min_confidence);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw brainError("request_params_invalid", "min_confidence must be between 0 and 1");
    }
    result.min_confidence = parsed;
  }
  if (query.limit !== undefined) {
    const parsed = Number.parseInt(query.limit, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw brainError("request_params_invalid", "limit must be a positive integer");
    }
    result.limit = Math.min(parsed, MAX_LIMIT);
  }
  if (query.cursor !== undefined) {
    decodeCursor(query.cursor);
    result.cursor = query.cursor;
  }
  return result;
}

export async function listProposals(
  pool: Pool,
  ctx: ServiceCallContext,
  input: ListProposalsInput,
): Promise<ListProposalsResult> {
  const limit = clampLimit(input.limit);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : null;
  const rows = await withTenantScope(pool, ctx.tenantId, (client) =>
    queryProposalRows(client, input, limit + 1, cursor),
  );
  const visibleRows = rows.slice(0, limit);
  const proposals = await withTenantScope(pool, ctx.tenantId, async (client) =>
    Promise.all(visibleRows.map((row) => serializeProposalRow(client, row))),
  );
  const last = visibleRows.at(-1);
  return {
    proposals,
    next_cursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ created_at: isoDate(last.created_at), id: last.id })
        : null,
  };
}

export async function getProposal(
  pool: Pool,
  ctx: ServiceCallContext,
  id: string,
): Promise<ProposalReadItem | null> {
  if (!isBrainId(id, "pi") && !isBrainId(id, "prop")) {
    throw brainError("request_params_invalid", "malformed proposal id");
  }
  return withTenantScope(pool, ctx.tenantId, async (client) => {
    const rows = await queryProposalRows(client, {}, 1, null, id);
    const row = rows[0];
    if (row === undefined) return null;
    return serializeProposalRow(client, row);
  });
}

export async function getPaymentIntentAgent(
  pool: Pool,
  ctx: ServiceCallContext,
  paymentIntentId: string,
): Promise<ProposalAgentRef | null> {
  return withTenantScope(pool, ctx.tenantId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      kind: string;
      display_name: string;
    }>(
      `SELECT a.id, a.kind, a.display_name
         FROM ledger_payment_intents pi
         JOIN agents a ON a.id = pi.created_by_agent_id AND a.tenant_id = pi.owner_id
        WHERE pi.id = $1
        LIMIT 1`,
      [paymentIntentId],
    );
    return rows[0] ?? null;
  });
}

async function queryProposalRows(
  client: TenantScopedClient,
  input: ListProposalsInput,
  limit: number,
  cursor: ProposalCursor | null,
  id?: string,
): Promise<RawProposalRow[]> {
  const values: unknown[] = [PROPOSAL_TYPES];
  const filters: string[] = ["type IS NOT NULL"];
  if (id !== undefined) {
    values.push(id);
    filters.push(`id = $${values.length}`);
  }
  if (input.type !== undefined) {
    values.push(input.type);
    filters.push(`type = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    filters.push(`status = $${values.length}`);
  }
  if (input.risk_band !== undefined) {
    values.push(input.risk_band);
    filters.push(`risk_band = $${values.length}`);
  }
  if (input.min_confidence !== undefined) {
    values.push(input.min_confidence);
    filters.push(`confidence IS NOT NULL AND confidence >= $${values.length}`);
  }
  if (cursor !== null) {
    values.push(cursor.created_at, cursor.id);
    filters.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  values.push(limit);
  const limitIndex = values.length;
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const { rows } = await client.query<RawProposalRow>(
    `WITH unified AS (
       SELECT
         pi.id,
         'payment_intent'::text AS source_kind,
         CASE WHEN a.role = ANY($1::text[]) THEN a.role ELSE 'payment' END AS type,
         pi.created_at,
         pi.status,
         NULL::text AS risk_band,
         pi.confidence::float8 AS confidence,
         'propose'::text AS mode,
         NULL::text AS narrative,
         NULL::jsonb AS action,
         pi.evidence_ids,
         a.id AS agent_id,
         a.kind AS agent_kind,
         a.display_name AS agent_display_name,
         pi.id AS payment_intent_id,
         pi.action_type
       FROM ledger_payment_intents pi
       LEFT JOIN agents a ON a.id = pi.created_by_agent_id AND a.tenant_id = pi.owner_id
       WHERE pi.created_by_agent_id IS NOT NULL
       UNION ALL
       SELECT
         p.id,
         'proposal'::text AS source_kind,
         CASE
           WHEN p.action->>'type' = ANY($1::text[]) THEN p.action->>'type'
           WHEN p.action->>'agent_kind' = ANY($1::text[]) THEN p.action->>'agent_kind'
           WHEN p.action->>'kind' = ANY($1::text[]) THEN p.action->>'kind'
           WHEN a.role = ANY($1::text[]) THEN a.role
           ELSE NULL
         END AS type,
         p.created_at,
         p.status,
         CASE WHEN p.action->>'risk_band' IN ('low','standard','elevated','high')
           THEN p.action->>'risk_band'
           ELSE NULL
         END AS risk_band,
         CASE WHEN p.action->>'confidence' ~ '^(0(\\.\\d+)?|1(\\.0+)?)$'
           THEN (p.action->>'confidence')::float8
           ELSE NULL
         END AS confidence,
         CASE WHEN p.action->>'mode' = 'notify_only' THEN 'notify_only' ELSE 'propose' END AS mode,
         COALESCE(p.action->>'narrative', p.action->>'summary', p.action->>'description') AS narrative,
         p.action,
         ARRAY[]::text[] AS evidence_ids,
         a.id AS agent_id,
         a.kind AS agent_kind,
         a.display_name AS agent_display_name,
         NULL::text AS payment_intent_id,
         NULL::text AS action_type
       FROM proposals p
       LEFT JOIN agents a ON a.id = p.proposing_agent AND a.tenant_id = p.tenant_id
     )
     SELECT * FROM unified
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${limitIndex}`,
    values,
  );
  return rows;
}

async function serializeProposalRow(
  client: TenantScopedClient,
  row: RawProposalRow,
): Promise<ProposalReadItem> {
  if (row.type === null || !PROPOSAL_TYPE_SET.has(row.type)) {
    throw new Error(`proposal ${row.id} did not resolve to a customer-facing type`);
  }
  const candidateEvidenceIds =
    row.source_kind === "payment_intent"
      ? (row.evidence_ids ?? [])
      : evidenceIdsFromAction(row.action ?? {});
  const evidence = await resolvableWikiEntityRefs(client, candidateEvidenceIds);
  return {
    id: row.id,
    type: row.type,
    created_at: isoDate(row.created_at),
    status: row.status,
    risk_band: row.risk_band !== null && RISK_BAND_SET.has(row.risk_band) ? row.risk_band : null,
    confidence: normalizeConfidence(row.confidence),
    mode: row.mode,
    narrative: row.narrative,
    evidence,
    agent:
      row.agent_id !== null && row.agent_kind !== null && row.agent_display_name !== null
        ? { id: row.agent_id, kind: row.agent_kind, display_name: row.agent_display_name }
        : null,
    payment_intent_id: row.payment_intent_id,
    action_type: row.action_type,
  };
}

function evidenceIdsFromAction(action: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  addEvidenceValue(ids, action["evidence_ids"]);
  addEvidenceValue(ids, action["evidence"]);
  addEvidenceValue(ids, action["evidence_refs"]);
  addEvidenceValue(ids, action["wiki_entity_ids"]);
  return [...ids];
}

function addEvidenceValue(ids: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    ids.add(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string") {
      ids.add(item);
    } else if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of ["id", "entity_id", "wiki_entity_id"]) {
        const id = record[key];
        if (typeof id === "string") ids.add(id);
      }
    }
  }
}

async function resolvableWikiEntityRefs(
  client: TenantScopedClient,
  candidates: string[],
): Promise<ProposalEvidenceRef[]> {
  const entityIds = [...new Set(candidates.filter((id) => isBrainId(id, "ent")))];
  if (entityIds.length === 0) return [];
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM wiki_entities WHERE id = ANY($1::text[]) AND valid_to IS NULL`,
    [entityIds],
  );
  const found = new Set(rows.map((row) => row.id));
  return entityIds.filter((id) => found.has(id)).map((id) => ({ id, type: "wiki_entity" }));
}

function normalizeConfidence(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function encodeCursor(cursor: ProposalCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): ProposalCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ProposalCursor>;
    if (
      typeof parsed.created_at !== "string" ||
      Number.isNaN(new Date(parsed.created_at).getTime()) ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("bad cursor");
    }
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    throw brainError("request_params_invalid", "cursor is invalid");
  }
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
