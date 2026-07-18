import { Buffer } from "node:buffer";
import {
  brainError,
  isBrainId,
  withTenantScope,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import {
  canonicalEvidenceKind,
  evidenceKindFromRefPrefix,
  isEvidenceKindResolvable,
} from "../evidence/resolve.js";

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
  "acknowledged",
  "reconciling",
  "paused",
  "dispatching",
  "rejected",
  "executed",
  "failed",
  "cancelled",
  "undone",
  "unknown",
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
  kind: string;
  ref: string;
  resolvable: boolean;
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

interface StoredEvidenceRef {
  kind: string;
  ref: string;
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
  const proposals = visibleRows.map((row) => serializeProposalRow(row));
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
    return serializeProposalRow(row);
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
         AND pi.owner_id = current_setting('app.tenant_id', true)
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
       WHERE p.tenant_id = current_setting('app.tenant_id', true)
     )
     SELECT * FROM unified
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${limitIndex}`,
    values,
  );
  return rows;
}

function serializeProposalRow(row: RawProposalRow): ProposalReadItem {
  if (row.type === null || !PROPOSAL_TYPE_SET.has(row.type)) {
    throw new Error(`proposal ${row.id} did not resolve to a customer-facing type`);
  }
  const candidateEvidenceRefs =
    row.source_kind === "payment_intent"
      ? evidenceRefsFromPaymentIntentIds(row.evidence_ids ?? [])
      : evidenceRefsFromAction(row.action ?? {});
  const evidence = resolvableEvidenceRefs(candidateEvidenceRefs);
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

function evidenceRefsFromAction(action: Record<string, unknown>): StoredEvidenceRef[] {
  const refs: StoredEvidenceRef[] = [];
  addEvidenceValue(refs, action["evidence_ids"]);
  addEvidenceValue(refs, action["evidence"]);
  addEvidenceValue(refs, action["evidence_refs"]);
  addEvidenceValue(refs, action["wiki_entity_ids"]);
  return refs;
}

function evidenceRefsFromPaymentIntentIds(ids: string[]): StoredEvidenceRef[] {
  return ids.map((ref) => ({ kind: kindFromPaymentIntentEvidenceRef(ref), ref }));
}

function addEvidenceValue(refs: StoredEvidenceRef[], value: unknown): void {
  if (typeof value === "string") {
    refs.push({ kind: evidenceKindFromRefPrefix(value) ?? "unknown", ref: value });
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string") {
      refs.push({ kind: evidenceKindFromRefPrefix(item) ?? "unknown", ref: item });
    } else if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const ref = firstString(record, ["ref", "id", "entity_id", "wiki_entity_id"]);
      if (ref === null) continue;
      refs.push({
        kind: evidenceKindFromRecord(record, ref),
        ref,
      });
    }
  }
}

function resolvableEvidenceRefs(candidates: StoredEvidenceRef[]): ProposalEvidenceRef[] {
  return candidates
    .filter((item) => item.ref.length > 0)
    .map((item) => {
      const kind = canonicalEvidenceKind(item.kind, item.ref);
      return {
        kind,
        ref: item.ref,
        resolvable: isEvidenceKindResolvable(kind),
      };
    });
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function evidenceKindFromRecord(record: Record<string, unknown>, ref: string): string {
  const byPrefix = evidenceKindFromRefPrefix(ref);
  if (byPrefix !== null) return byPrefix;
  const kind = record["kind"];
  if (typeof kind === "string" && kind.trim().length > 0) return kind.trim();
  if (typeof record["wiki_entity_id"] === "string") return "wiki_entity";
  return bestEffortKindByRef(ref);
}

function kindFromPaymentIntentEvidenceRef(ref: string): string {
  if (ref.startsWith("doc_")) return "document";
  return evidenceKindFromRefPrefix(ref) ?? bestEffortKindByRef(ref);
}

function bestEffortKindByRef(ref: string): string {
  const prefix = ref.split("_", 1)[0];
  switch (prefix) {
    case "acct":
      return "account";
    case "agent":
      return "agent";
    case "cp":
      return "counterparty";
    case "doc":
      return "document";
    case "ent":
      return "wiki_entity";
    case "inv":
      return "invoice";
    case "obl":
      return "obligation";
    case "pd":
      return "policy_decision";
    case "pi":
      return "payment_intent";
    case "pol":
      return "policy";
    case "prs":
      return "raw_parsed";
    case "raw":
      return "raw_artifact";
    case "tx":
      return "transaction";
    default:
      return "unknown";
  }
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
