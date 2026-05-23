/**
 * agent_runs / routing_decisions / reasoning_traces / run_steps / evidence_refs /
 * idempotency_keys repositories. Agent Autonomy v3 (1a.3 + 1a.5). All tenant-scoped
 * (run through withTenantScope so RLS applies).
 */

import type { ExecutionMode, TenantScopedClient } from "@brain/shared";
import type { AgentPolicyStatus, AgentRunStatus } from "@brain/schemas";

// ---------------------------------------------------------------------------
// Event-layer idempotency key (1a.5)
// ---------------------------------------------------------------------------

/** UTC day bucket (YYYY-MM-DD) so a still-true event re-firing later is a new run. */
export function dayBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export function buildEventIdempotencyKey(parts: {
  tenantId: string;
  eventType: string;
  objectType: string;
  objectId: string;
  agentId: string;
  action: string;
  day?: string;
}): string {
  return [
    parts.tenantId,
    parts.eventType,
    parts.objectType,
    parts.objectId,
    parts.agentId,
    parts.action,
    parts.day ?? dayBucket(),
  ].join(":");
}

// ---------------------------------------------------------------------------
// Proposal-layer idempotency key (1a.5) — blocks duplicate proposals from one run
// ---------------------------------------------------------------------------

/**
 * Bucket an amount to the nearest whole major unit so two slightly-different
 * proposals from the same run (LLM nondeterminism) collide. Returns the input
 * unchanged if it is not a finite number.
 */
export function amountBucket(amount: string): string {
  const n = Number(amount);
  return Number.isFinite(n) ? String(Math.round(n)) : amount;
}

/**
 * Build the proposal-layer dedup key:
 *   (tenant_id, agent_id, obligation_id || invoice_id || (counterparty_id + amount_bucket + day))
 * Returns null when there is no stable discriminator (then no dedup is enforced).
 */
export function buildProposalDedupKey(parts: {
  tenantId: string;
  agentId: string;
  obligationId?: string | null;
  invoiceId?: string | null;
  counterpartyId?: string | null;
  amount?: string | null;
  currency?: string | null;
  day?: string;
}): string | null {
  const { tenantId, agentId } = parts;
  if (typeof parts.obligationId === "string" && parts.obligationId !== "") {
    return `${tenantId}:${agentId}:obl:${parts.obligationId}`;
  }
  if (typeof parts.invoiceId === "string" && parts.invoiceId !== "") {
    return `${tenantId}:${agentId}:inv:${parts.invoiceId}`;
  }
  if (
    typeof parts.counterpartyId === "string" &&
    parts.counterpartyId !== "" &&
    typeof parts.amount === "string" &&
    typeof parts.currency === "string"
  ) {
    const day = parts.day ?? dayBucket();
    return `${tenantId}:${agentId}:cpa:${parts.counterpartyId}:${parts.currency}:${amountBucket(parts.amount)}:${day}`;
  }
  return null;
}

/** True for a Postgres unique-violation (SQLSTATE 23505) — a dedup collision. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

// ---------------------------------------------------------------------------
// agent_runs
// ---------------------------------------------------------------------------

export interface AgentRunRow {
  id: string;
  tenant_id: string;
  tenant_category: string;
  agent_id: string;
  agent_kind: "internal" | "external";
  event_type: string | null;
  intent: string | null;
  object_type: string | null;
  object_id: string | null;
  action: string | null;
  execution_mode: ExecutionMode;
  status: AgentRunStatus;
  confidence: number | null;
  evidence_score: number | null;
  policy_status: AgentPolicyStatus | null;
  proposal_id: string | null;
  payment_intent_id: string | null;
  policy_decision_id: string | null;
  idempotency_key: string | null;
  reasoning_trace_id: string | null;
  routing_decision_id: string | null;
  reason: Record<string, unknown>;
  failure_reason: string | null;
  shadow_mode: boolean;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface InsertAgentRunInput {
  id: string;
  tenantId: string;
  tenantCategory: string;
  agentId: string;
  agentKind: "internal" | "external";
  executionMode: ExecutionMode;
  status: AgentRunStatus;
  reason: Record<string, unknown>;
  shadowMode: boolean;
  eventType?: string | null;
  intent?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  action?: string | null;
  confidence?: number | null;
  evidenceScore?: number | null;
  policyStatus?: AgentPolicyStatus | null;
  proposalId?: string | null;
  paymentIntentId?: string | null;
  policyDecisionId?: string | null;
  idempotencyKey?: string | null;
  reasoningTraceId?: string | null;
  routingDecisionId?: string | null;
  failureReason?: string | null;
}

export async function insertAgentRun(
  client: TenantScopedClient,
  input: InsertAgentRunInput,
): Promise<AgentRunRow> {
  const { rows } = await client.query<AgentRunRow>(
    `INSERT INTO agent_runs (
       id, tenant_id, tenant_category, agent_id, agent_kind, event_type, intent,
       object_type, object_id, action, execution_mode, status, confidence,
       evidence_score, policy_status, proposal_id, payment_intent_id,
       policy_decision_id, idempotency_key, reasoning_trace_id, routing_decision_id,
       reason, failure_reason, shadow_mode
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
     ) RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.tenantCategory,
      input.agentId,
      input.agentKind,
      input.eventType ?? null,
      input.intent ?? null,
      input.objectType ?? null,
      input.objectId ?? null,
      input.action ?? null,
      input.executionMode,
      input.status,
      input.confidence ?? null,
      input.evidenceScore ?? null,
      input.policyStatus ?? null,
      input.proposalId ?? null,
      input.paymentIntentId ?? null,
      input.policyDecisionId ?? null,
      input.idempotencyKey ?? null,
      input.reasoningTraceId ?? null,
      input.routingDecisionId ?? null,
      JSON.stringify(input.reason),
      input.failureReason ?? null,
      input.shadowMode,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("agent_runs insert returned no row");
  return row;
}

export async function findAgentRun(
  client: TenantScopedClient,
  id: string,
): Promise<AgentRunRow | null> {
  const { rows } = await client.query<AgentRunRow>(
    `SELECT * FROM agent_runs WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface UpdateAgentRunInput {
  status?: AgentRunStatus;
  proposalId?: string | null;
  paymentIntentId?: string | null;
  policyDecisionId?: string | null;
  policyStatus?: AgentPolicyStatus | null;
  reasoningTraceId?: string | null;
  failureReason?: string | null;
  completed?: boolean;
}

/** Patch a run's mutable fields. `completed` sets completed_at = now(). */
export async function updateAgentRun(
  client: TenantScopedClient,
  id: string,
  patch: UpdateAgentRunInput,
): Promise<AgentRunRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [];
  const add = (col: string, val: unknown): void => {
    values.push(val);
    sets.push(`${col} = $${values.length + 1}`);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.proposalId !== undefined) add("proposal_id", patch.proposalId);
  if (patch.paymentIntentId !== undefined) add("payment_intent_id", patch.paymentIntentId);
  if (patch.policyDecisionId !== undefined) add("policy_decision_id", patch.policyDecisionId);
  if (patch.policyStatus !== undefined) add("policy_status", patch.policyStatus);
  if (patch.reasoningTraceId !== undefined) add("reasoning_trace_id", patch.reasoningTraceId);
  if (patch.failureReason !== undefined) add("failure_reason", patch.failureReason);
  if (patch.completed === true) sets.push("completed_at = now()");
  const { rows } = await client.query<AgentRunRow>(
    `UPDATE agent_runs SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return rows[0] ?? null;
}

export interface ListAgentRunsFilter {
  agentId?: string;
  status?: AgentRunStatus;
  category?: string;
  limit?: number;
}

export async function listAgentRuns(
  client: TenantScopedClient,
  filter: ListAgentRunsFilter = {},
): Promise<AgentRunRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, val: unknown): void => {
    values.push(val);
    where.push(`${clause} $${values.length}`);
  };
  if (filter.agentId !== undefined) add("agent_id =", filter.agentId);
  if (filter.status !== undefined) add("status =", filter.status);
  if (filter.category !== undefined) add("tenant_category =", filter.category);
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const { rows } = await client.query<AgentRunRow>(
    `SELECT * FROM agent_runs ${whereSql} ORDER BY created_at DESC LIMIT ${limit}`,
    values,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// agent_routing_decisions
// ---------------------------------------------------------------------------

export interface AgentRoutingDecisionRow {
  id: string;
  tenant_id: string;
  tenant_category: string;
  event_type: string | null;
  intent: string | null;
  selected_agent_id: string | null;
  fallback_agent_ids: string[];
  policy_status: "routed" | "no_match" | "unscoped";
  confidence: number | null;
  evidence_score: number | null;
  reason: Record<string, unknown>;
  created_at: Date;
}

export interface InsertRoutingDecisionInput {
  id: string;
  tenantId: string;
  tenantCategory: string;
  policyStatus: "routed" | "no_match" | "unscoped";
  reason: Record<string, unknown>;
  eventType?: string | null;
  intent?: string | null;
  selectedAgentId?: string | null;
  fallbackAgentIds?: string[];
  confidence?: number | null;
  evidenceScore?: number | null;
}

export async function insertRoutingDecision(
  client: TenantScopedClient,
  input: InsertRoutingDecisionInput,
): Promise<AgentRoutingDecisionRow> {
  const { rows } = await client.query<AgentRoutingDecisionRow>(
    `INSERT INTO agent_routing_decisions (
       id, tenant_id, tenant_category, event_type, intent, selected_agent_id,
       fallback_agent_ids, policy_status, confidence, evidence_score, reason
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      input.id,
      input.tenantId,
      input.tenantCategory,
      input.eventType ?? null,
      input.intent ?? null,
      input.selectedAgentId ?? null,
      input.fallbackAgentIds ?? [],
      input.policyStatus,
      input.confidence ?? null,
      input.evidenceScore ?? null,
      JSON.stringify(input.reason),
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("agent_routing_decisions insert returned no row");
  return row;
}

export async function findRoutingDecision(
  client: TenantScopedClient,
  id: string,
): Promise<AgentRoutingDecisionRow | null> {
  const { rows } = await client.query<AgentRoutingDecisionRow>(
    `SELECT * FROM agent_routing_decisions WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// agent_run_steps
// ---------------------------------------------------------------------------

export async function insertRunStep(
  client: TenantScopedClient,
  input: {
    id: string;
    tenantId: string;
    runId: string;
    stepIndex: number;
    kind: string;
    status: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO agent_run_steps (id, tenant_id, run_id, step_index, kind, status, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.id,
      input.tenantId,
      input.runId,
      input.stepIndex,
      input.kind,
      input.status,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

// ---------------------------------------------------------------------------
// agent_evidence_refs
// ---------------------------------------------------------------------------

export interface InsertEvidenceRefInput {
  id: string;
  tenantId: string;
  runId: string;
  kind: string;
  ref: string;
  sourceSystem?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  confidence?: number | null;
  evidenceTimestamp?: string | null;
  hash?: Buffer | null;
  excerpt?: string | null;
  fieldRefs?: string[] | null;
  stale?: boolean;
  weight?: number | null;
  required?: boolean | null;
}

export async function insertEvidenceRef(
  client: TenantScopedClient,
  input: InsertEvidenceRefInput,
): Promise<void> {
  await client.query(
    `INSERT INTO agent_evidence_refs (
       id, tenant_id, run_id, kind, ref, source_system, object_type, object_id,
       confidence, evidence_timestamp, hash, excerpt, field_refs, stale, weight, required
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      input.id,
      input.tenantId,
      input.runId,
      input.kind,
      input.ref,
      input.sourceSystem ?? null,
      input.objectType ?? null,
      input.objectId ?? null,
      input.confidence ?? null,
      input.evidenceTimestamp ?? null,
      input.hash ?? null,
      input.excerpt ?? null,
      input.fieldRefs ?? null,
      input.stale ?? false,
      input.weight ?? null,
      input.required ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// agent_reasoning_traces (redacted-view insert; raw blobs go to KMS-encrypted blob)
// ---------------------------------------------------------------------------

export interface InsertReasoningTraceInput {
  id: string;
  tenantId: string;
  agentId: string;
  runId: string;
  modelId: string;
  modelVersion: string;
  promptTemplateHash: Buffer;
  toolManifestHash: Buffer;
  retrievedEvidenceIds: string[];
  toolCallsRedacted: Record<string, unknown>;
  outputStructured: Record<string, unknown>;
  redactionPolicyId: string;
  toolCallsRawUri?: string | null;
  toolCallsRawHash: Buffer;
  outputRawUri?: string | null;
  outputRawHash: Buffer;
  llmTokensIn: number;
  llmTokensOut: number;
  llmCostUsd: string;
}

export async function insertReasoningTrace(
  client: TenantScopedClient,
  input: InsertReasoningTraceInput,
): Promise<void> {
  await client.query(
    `INSERT INTO agent_reasoning_traces (
       id, tenant_id, agent_id, run_id, model_id, model_version, prompt_template_hash,
       tool_manifest_hash, retrieved_evidence_ids, tool_calls_redacted, output_structured,
       redaction_policy_id, tool_calls_raw_uri, tool_calls_raw_hash, output_raw_uri,
       output_raw_hash, llm_tokens_in, llm_tokens_out, llm_cost_usd
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      input.id,
      input.tenantId,
      input.agentId,
      input.runId,
      input.modelId,
      input.modelVersion,
      input.promptTemplateHash,
      input.toolManifestHash,
      input.retrievedEvidenceIds,
      JSON.stringify(input.toolCallsRedacted),
      JSON.stringify(input.outputStructured),
      input.redactionPolicyId,
      input.toolCallsRawUri ?? null,
      input.toolCallsRawHash,
      input.outputRawUri ?? null,
      input.outputRawHash,
      input.llmTokensIn,
      input.llmTokensOut,
      input.llmCostUsd,
    ],
  );
}

// ---------------------------------------------------------------------------
// agent_idempotency_keys (event layer, 1a.5)
// ---------------------------------------------------------------------------

export interface ClaimResult {
  /** True if THIS call inserted the key (i.e. this is the first run for it). */
  readonly claimed: boolean;
  /** The run_id bound to the key (the new one if claimed, else the existing one). */
  readonly runId: string | null;
}

/**
 * Atomically claim the event-layer idempotency key for a run. On a duplicate
 * (key already present), returns claimed:false with the existing run_id so the
 * caller can return duplicate_skipped without invoking the handler.
 */
export async function claimEventIdempotencyKey(
  client: TenantScopedClient,
  input: { id: string; tenantId: string; key: string; runId: string },
): Promise<ClaimResult> {
  const { rows } = await client.query<{ run_id: string }>(
    `INSERT INTO agent_idempotency_keys (id, tenant_id, idempotency_key, run_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING run_id`,
    [input.id, input.tenantId, input.key, input.runId],
  );
  if (rows.length > 0) {
    return { claimed: true, runId: input.runId };
  }
  const existing = await client.query<{ run_id: string }>(
    `SELECT run_id FROM agent_idempotency_keys
       WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [input.tenantId, input.key],
  );
  return { claimed: false, runId: existing.rows[0]?.run_id ?? null };
}
