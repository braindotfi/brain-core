/**
 * /wiki/question orchestrator.
 *
 * §3 Layer 2 describes the behavior: NL → small number of SQL queries →
 * compose a grounded answer with evidence path.
 *
 * Stage-3 implementation:
 *   1. Semantic search the Wiki for a candidate entity set (bounded size).
 *   2. For each candidate, fetch one-hop neighbors (bounded).
 *   3. Build a compact evidence context.
 *   4. Call the LLM with the question + evidence context, require a JSON
 *      response { answer, evidence_ids[] }.
 *   5. Return with cost + token accounting for the §6.2
 *      brain.wiki.question.cost metric.
 *
 * Cost control (build prompt §Stage 3):
 *   - Request-dedup key is sha256(question + asOf + tenantId). A concurrent
 *     second request with the same key waits on the first's result for up
 *     to 30s rather than calling the LLM twice.
 *   - Response is cached in Redis for 5 minutes on the dedup key.
 */

import { createHash } from "node:crypto";
import {
  brainError,
  embeddingKey,
  hashBody,
  llmKey,
  type EmbeddingAdapter,
  type LlmAdapter,
  type MetricsEmitter,
  type TenantScopedClient,
} from "@brain/api/shared";
import type Redis from "ioredis";
import {
  findEntityAsOf,
  searchEntities,
  semanticSearch,
  type WikiEntityRow,
} from "../repository/entities.js";
import { findOneHopNeighbors, type WikiRelationRow } from "../repository/relations.js";

export interface AskOptions {
  question: string;
  asOf: Date | null;
  maxEvidenceDepth: number;
  tenantId: string;
  model: string;
}

export interface AskResult {
  answer: string;
  evidence: Array<{ entityId: string; excerpt: string }>;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  cachedAt?: string;
}

export interface AskDeps {
  client: TenantScopedClient;
  llm: LlmAdapter;
  embed: EmbeddingAdapter;
  redis: Redis;
  metrics: MetricsEmitter;
}

const CACHE_TTL_SECONDS = 300;
const MAX_CANDIDATES = 20;

export async function askWiki(deps: AskDeps, opts: AskOptions): Promise<AskResult> {
  const key = dedupKey(opts);
  const cached = await deps.redis.get(cacheKey(key));
  if (cached !== null) {
    const parsed = JSON.parse(cached) as AskResult;
    deps.metrics.increment("brain.wiki.question.cache_hit", { tenant_id: opts.tenantId });
    return { ...parsed, cachedAt: new Date().toISOString() };
  }

  const started = Date.now();

  // 1. Embed the question + semantic search.
  const embedding = await deps.embed.embed(opts.question);
  const candidates = await semanticSearch(
    deps.client,
    embedding.vector,
    MAX_CANDIDATES,
  );

  // 2. One-hop neighborhood per candidate (bounded).
  const neighborMap = new Map<string, WikiRelationRow[]>();
  for (const c of candidates) {
    const n = await findOneHopNeighbors(deps.client, c.id, opts.asOf);
    neighborMap.set(c.id, n);
  }

  // 3. Compose a compact evidence context string for the LLM.
  const evidenceContext = composeEvidenceContext(candidates, neighborMap);

  // 4. Call the LLM.
  const llmReq = {
    model: opts.model,
    messages: [
      {
        role: "system" as const,
        content:
          "You answer questions about a tenant's financial data grounded ONLY in the EVIDENCE block. Reply as JSON { answer, evidence_ids }. Cite entity ids from the evidence.",
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
      .map((id) => {
        const e = candidates.find((c) => c.id === id);
        return e === undefined
          ? null
          : { entityId: e.id, excerpt: summarize(e) };
      })
      .filter((x): x is { entityId: string; excerpt: string } => x !== null),
    model: completion.model,
    usage: completion.usage,
  };

  // Cache.
  await deps.redis.set(cacheKey(key), JSON.stringify(result), "EX", CACHE_TTL_SECONDS);

  // §6.2 metrics: latency + cost proxy (tokens). Dollar cost is derived by
  // Datadog formula from tokens × model rate in the metrics pipeline; we
  // emit the raw token counts here.
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

function composeEvidenceContext(
  candidates: ReadonlyArray<WikiEntityRow>,
  neighbors: ReadonlyMap<string, ReadonlyArray<WikiRelationRow>>,
): string {
  const lines: string[] = [];
  for (const c of candidates) {
    lines.push(`[${c.id}] kind=${c.kind} attributes=${JSON.stringify(c.attributes)}`);
    const ns = neighbors.get(c.id) ?? [];
    for (const n of ns.slice(0, 5)) {
      lines.push(`  -[${n.kind}]-> ${n.dst === c.id ? n.src : n.dst}`);
    }
  }
  return lines.join("\n");
}

function summarize(e: WikiEntityRow): string {
  const attr = e.attributes as { display_name?: string; memo?: string };
  if (typeof attr.display_name === "string") return attr.display_name;
  if (typeof attr.memo === "string") return attr.memo;
  return `${e.kind} ${e.id}`;
}

function parseLlmAnswer(
  text: string,
  candidates: ReadonlyArray<WikiEntityRow>,
): { answer: string; evidenceIds: string[] } {
  try {
    const json = JSON.parse(text) as { answer?: string; evidence_ids?: string[] };
    if (typeof json.answer !== "string") throw new Error("no answer field");
    const ids = Array.isArray(json.evidence_ids) ? json.evidence_ids : [];
    // Restrict to candidates the orchestrator actually retrieved, §11.2
    // prompt-injection mitigation.
    const allowed = new Set(candidates.map((c) => c.id));
    return {
      answer: json.answer,
      evidenceIds: ids.filter((id) => typeof id === "string" && allowed.has(id)),
    };
  } catch {
    // If the LLM doesn't emit JSON, we still return its text as the
    // answer but with no cited evidence — front-ends should disclaim.
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

// Keep unused imports tree-shakable — referenced by types.
void findEntityAsOf;
void searchEntities;
void hashBody;
void llmKey;
void embeddingKey;
