/**
 * /wiki/question orchestrator — v0.3 (Ledger-grounded).
 *
 * Per `Brain_MVP_Architecture.md` §3 Layer 3 + Engineering Standards
 * §1.5 (deterministic pre-execution gate principle), the question
 * endpoint grounds in **Ledger rows**, not in Wiki text. Wiki provides
 * retrieval scaffolding (Phase 5 will introduce wiki_pages with
 * embeddings for narrative recall); the cited facts come from the
 * Ledger.
 *
 * Phase 3 implementation is intentionally simple:
 *   1. Pull recent Ledger transactions, obligations, and counterparties
 *      under tenant scope (bounded). No semantic search yet — that
 *      lands when wiki_pages is materialized in Phase 5.
 *   2. Build a compact evidence context from the Ledger rows.
 *   3. Call the LLM with the question + evidence; require JSON output
 *      { answer, evidence_ids[] }.
 *   4. Filter cited evidence_ids against the retrieved set to mitigate
 *      §11.2 prompt-injection (the LLM cannot cite something it wasn't
 *      shown).
 *   5. Cache and emit metrics as before.
 *
 * Cost control retained:
 *   - dedup key sha256(question + asOf + tenantId + model)
 *   - 5-minute Redis cache on dedup key
 *   - explicit per-tenant tagging on cost / latency metrics
 */

import { createHash } from "node:crypto";
import {
  type EmbeddingAdapter,
  type LlmAdapter,
  type MetricsEmitter,
  type TenantScopedClient,
} from "@brain/shared";
import type { Redis } from "ioredis";

export interface AskOptions {
  question: string;
  asOf: Date | null;
  maxEvidenceDepth: number;
  tenantId: string;
  model: string;
}

export interface AskEvidenceItem {
  entityType: "transaction" | "obligation" | "counterparty";
  entityId: string;
  excerpt: string;
}

export interface AskResult {
  answer: string;
  evidence: AskEvidenceItem[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  cachedAt?: string;
}

export interface AskDeps {
  client: TenantScopedClient;
  llm: LlmAdapter;
  /** Retained for compatibility. Phase 5 will use this for wiki_pages search. */
  embed: EmbeddingAdapter;
  redis: Redis;
  metrics: MetricsEmitter;
}

const CACHE_TTL_SECONDS = 300;
const MAX_TRANSACTIONS = 30;
const MAX_OBLIGATIONS = 15;
const MAX_COUNTERPARTIES = 15;

interface LedgerCandidate {
  type: "transaction" | "obligation" | "counterparty";
  id: string;
  excerpt: string;
}

export async function askWiki(deps: AskDeps, opts: AskOptions): Promise<AskResult> {
  const key = dedupKey(opts);
  const cached = await deps.redis.get(cacheKey(key));
  if (cached !== null) {
    const parsed = JSON.parse(cached) as AskResult;
    deps.metrics.increment("brain.wiki.question.cache_hit", { tenant_id: opts.tenantId });
    return { ...parsed, cachedAt: new Date().toISOString() };
  }

  const started = Date.now();

  // 1. Pull a bounded slice of recent Ledger state. Phase 5 layers in
  //    wiki_pages embeddings; Phase 3 keeps the retrieval surface narrow.
  const candidates = await retrieveLedgerCandidates(deps.client, opts.asOf);

  // 2. Compose evidence context.
  const evidenceContext = composeEvidenceContext(candidates);

  // 3. Call the LLM.
  const llmReq = {
    model: opts.model,
    messages: [
      {
        role: "system" as const,
        content:
          "You answer questions about a tenant's financial data grounded ONLY in the EVIDENCE block. Each evidence row has a typed id like `tx_..`, `obl_..`, or `cp_..`. Reply as JSON { answer, evidence_ids }. evidence_ids must be a subset of the EVIDENCE block ids.",
      },
      {
        role: "user" as const,
        content: `QUESTION:\n${opts.question}\n\nEVIDENCE:\n${evidenceContext}`,
      },
    ],
    temperature: 0,
    maxTokens: 800,
    timeoutMs: 15_000,
  };

  const completion = await deps.llm.complete(llmReq);
  const parsed = parseLlmAnswer(completion.text, candidates);

  const result: AskResult = {
    answer: parsed.answer,
    evidence: parsed.evidenceIds
      .map((id) => candidates.find((c) => c.id === id))
      .filter((c): c is LedgerCandidate => c !== undefined)
      .map((c) => ({ entityType: c.type, entityId: c.id, excerpt: c.excerpt })),
    model: completion.model,
    usage: completion.usage,
  };

  await deps.redis.set(cacheKey(key), JSON.stringify(result), "EX", CACHE_TTL_SECONDS);

  // §6.2 / §7.2 metrics.
  const latencyMs = Date.now() - started;
  deps.metrics.duration("brain.wiki.question.latency", latencyMs, {
    model: opts.model,
    tenant_id: opts.tenantId,
  });
  deps.metrics.histogram(
    "brain.wiki.question.cost",
    completion.usage.inputTokens + completion.usage.outputTokens,
    { model: opts.model, tenant_id: opts.tenantId },
  );

  return result;
}

// ---------------------------------------------------------------------------
// Ledger retrieval — direct SQL against the same connection. Tenant scoping
// comes from the withTenantScope wrapper the caller already established
// (the route handler obtains a TenantScopedClient).
// ---------------------------------------------------------------------------

async function retrieveLedgerCandidates(
  client: TenantScopedClient,
  asOf: Date | null,
): Promise<LedgerCandidate[]> {
  const txClause = asOf === null ? "" : "AND transaction_date <= $1";
  const txValues: unknown[] = asOf === null ? [MAX_TRANSACTIONS] : [asOf, MAX_TRANSACTIONS];
  const txLimitParam = asOf === null ? "$1" : "$2";

  const txRes = await client.query<{
    id: string;
    amount: string;
    currency: string;
    direction: string;
    transaction_date: Date;
    description_normalized: string | null;
    description_raw: string | null;
    counterparty_id: string | null;
  }>(
    `SELECT id, amount, currency, direction, transaction_date,
            description_normalized, description_raw, counterparty_id
       FROM ledger_transactions
      WHERE status IN ('posted','cleared') ${txClause}
      ORDER BY transaction_date DESC
      LIMIT ${txLimitParam}`,
    txValues,
  );

  const oblRes = await client.query<{
    id: string;
    type: string;
    amount_due: string;
    currency: string;
    due_date: Date;
    status: string;
    counterparty_id: string;
  }>(
    `SELECT id, type, amount_due, currency, due_date, status, counterparty_id
       FROM ledger_obligations
      WHERE status IN ('upcoming','due','overdue')
      ORDER BY due_date ASC
      LIMIT $1`,
    [MAX_OBLIGATIONS],
  );

  const cpRes = await client.query<{
    id: string;
    name: string;
    type: string;
    risk_level: string | null;
  }>(
    `SELECT id, name, type, risk_level
       FROM ledger_counterparties
      ORDER BY updated_at DESC
      LIMIT $1`,
    [MAX_COUNTERPARTIES],
  );

  const out: LedgerCandidate[] = [];
  for (const r of txRes.rows) {
    const cp = r.counterparty_id !== null ? ` cp=${r.counterparty_id}` : "";
    const memo = r.description_normalized ?? r.description_raw ?? "";
    out.push({
      type: "transaction",
      id: r.id,
      excerpt:
        `${r.direction} ${r.amount} ${r.currency} on ${r.transaction_date.toISOString().slice(0, 10)}${cp} ${memo}`.trim(),
    });
  }
  for (const r of oblRes.rows) {
    // Include the counterparty link (always present — NOT NULL FK) so the
    // model can answer "what do I owe and to whom" by joining to the cp_ row.
    out.push({
      type: "obligation",
      id: r.id,
      excerpt: `${r.type} due ${r.due_date.toISOString().slice(0, 10)} amount ${r.amount_due} ${r.currency} status=${r.status} cp=${r.counterparty_id}`,
    });
  }
  for (const r of cpRes.rows) {
    const risk = r.risk_level !== null ? ` risk=${r.risk_level}` : "";
    out.push({
      type: "counterparty",
      id: r.id,
      excerpt: `${r.type} "${r.name}"${risk}`,
    });
  }
  return out;
}

function composeEvidenceContext(candidates: ReadonlyArray<LedgerCandidate>): string {
  return candidates.map((c) => `[${c.id}] (${c.type}) ${c.excerpt}`).join("\n");
}

/**
 * Strip a leading/trailing markdown code fence so the inner JSON parses. Some
 * models (e.g. gpt-4o-mini) wrap their JSON in ```json … ``` even when asked for
 * raw JSON; without this the parse below throws and we lose evidence_ids.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced !== null ? fenced[1]!.trim() : trimmed;
}

function parseLlmAnswer(
  text: string,
  candidates: ReadonlyArray<LedgerCandidate>,
): { answer: string; evidenceIds: string[] } {
  try {
    const json = JSON.parse(stripCodeFence(text)) as { answer?: string; evidence_ids?: string[] };
    if (typeof json.answer !== "string") throw new Error("no answer field");
    const ids = Array.isArray(json.evidence_ids) ? json.evidence_ids : [];
    const allowed = new Set(candidates.map((c) => c.id));
    return {
      answer: json.answer,
      evidenceIds: ids.filter((id) => typeof id === "string" && allowed.has(id)),
    };
  } catch {
    return { answer: text, evidenceIds: [] };
  }
}

function dedupKey(opts: AskOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        question: opts.question,
        asOf: opts.asOf?.toISOString() ?? null,
        tenantId: opts.tenantId,
        model: opts.model,
      }),
    )
    .digest("hex");
}

function cacheKey(dedup: string): string {
  return `wiki:q:${dedup}`;
}
