/**
 * Embedding-based intent classification (Phase 4).
 *
 * `RulesIntentClassifier` (Phase 1) scores by token overlap, so it misses
 * paraphrases ("chase late-paying customers" shares no tokens with "follow up
 * on overdue invoices"). `EmbeddingIntentClassifier` embeds the intent and the
 * agent's `intent_patterns` and scores by cosine similarity, so semantically
 * close phrasings match.
 *
 * It ships behind a feature flag with `RulesIntentClassifier` retained as the
 * fallback (see `FallbackIntentClassifier` + the wiring in services/api). It
 * implements the same `IntentClassifier` interface — `classify` is async here,
 * which the (now-async) router awaits.
 */

import type { EmbeddingAdapter } from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import type { IntentClassifier } from "./intent-classifier.js";

/**
 * Cosine similarity at/above which the embedding classifier considers an
 * intent a confident match for a pattern. Maps to the Phase 4 plan's
 * "threshold 0.55". Below it, `classify` returns 0 ("not recognized"), which
 * is the signal `FallbackIntentClassifier` uses to defer to the rules-based
 * classifier.
 */
export const DEFAULT_EMBEDDING_MATCH_THRESHOLD = 0.55;

/** Default cap on the intent-vector cache (pattern vectors are not capped). */
const DEFAULT_INTENT_CACHE_SIZE = 4096;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Cosine similarity of two equal-length vectors; 0 when either is degenerate. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i += 1) {
    // noUncheckedIndexedAccess: `?? 0` is safe — i < min(length).
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface EmbeddingIntentClassifierOptions {
  /** Embedding model override; defaults to the adapter's default. */
  readonly model?: string;
  /** Cosine cutoff for a confident match. Default 0.55. */
  readonly matchThreshold?: number;
  /** Cap on cached intent vectors (FIFO eviction). Default 4096. */
  readonly intentCacheSize?: number;
}

export class EmbeddingIntentClassifier implements IntentClassifier {
  /** Operational match threshold (exposed so callers can mirror it). */
  public readonly matchThreshold: number;
  private readonly model: string | undefined;
  private readonly intentCacheSize: number;
  /** Pattern vectors — bounded by the catalog, never evicted. */
  private readonly patternVectors = new Map<string, number[]>();
  /** Intent vectors — free-form input, FIFO-evicted at `intentCacheSize`. */
  private readonly intentVectors = new Map<string, number[]>();

  public constructor(
    private readonly embedder: EmbeddingAdapter,
    opts: EmbeddingIntentClassifierOptions = {},
  ) {
    this.matchThreshold = opts.matchThreshold ?? DEFAULT_EMBEDDING_MATCH_THRESHOLD;
    this.model = opts.model;
    this.intentCacheSize = opts.intentCacheSize ?? DEFAULT_INTENT_CACHE_SIZE;
  }

  /**
   * Pre-compute and cache vectors for `patterns`. Call at boot (and after a
   * catalog change) so the first live request does not pay the embed latency.
   * Returns the number of newly-embedded patterns.
   */
  public async index(patterns: Iterable<string>): Promise<number> {
    let indexed = 0;
    for (const pattern of patterns) {
      if (!this.patternVectors.has(pattern)) {
        this.patternVectors.set(pattern, await this.embed(pattern));
        indexed += 1;
      }
    }
    return indexed;
  }

  public async classify(intent: string, patterns: readonly string[]): Promise<number> {
    if (patterns.length === 0 || intent.trim().length === 0) {
      return 0;
    }
    const intentVector = await this.intentVector(intent);
    let best = 0;
    for (const pattern of patterns) {
      const patternVector = await this.patternVector(pattern);
      const sim = cosineSimilarity(intentVector, patternVector);
      if (sim > best) {
        best = sim;
      }
    }
    // Below the match threshold the intent is "not recognized": report 0 so
    // FallbackIntentClassifier defers to the rules-based classifier.
    return best >= this.matchThreshold ? clamp01(best) : 0;
  }

  private async patternVector(pattern: string): Promise<number[]> {
    const hit = this.patternVectors.get(pattern);
    if (hit !== undefined) {
      return hit;
    }
    const vector = await this.embed(pattern);
    this.patternVectors.set(pattern, vector);
    return vector;
  }

  private async intentVector(intent: string): Promise<number[]> {
    const hit = this.intentVectors.get(intent);
    if (hit !== undefined) {
      return hit;
    }
    const vector = await this.embed(intent);
    if (this.intentVectors.size >= this.intentCacheSize) {
      const oldest = this.intentVectors.keys().next().value;
      if (oldest !== undefined) {
        this.intentVectors.delete(oldest);
      }
    }
    this.intentVectors.set(intent, vector);
    return vector;
  }

  private async embed(text: string): Promise<number[]> {
    const result = await this.embedder.embed(text, this.model);
    return result.vector;
  }
}

export interface FallbackIntentClassifierOptions {
  /**
   * Primary score strictly above this value is trusted as-is; at or below it
   * (e.g. the embedding classifier reporting 0 = "not recognized") the
   * fallback classifier is consulted and the larger score wins. Default 0.
   */
  readonly deferAtOrBelow?: number;
}

/**
 * Chains a primary classifier (embedding) to a fallback (rules):
 *   - primary recognizes the intent (score > `deferAtOrBelow`) → use it;
 *   - primary does not recognize it → use the fallback score;
 *   - primary throws (adapter unavailable) → degrade to the fallback.
 *
 * This is what keeps the rules-based classifier as a live fallback when the
 * embedding feature flag is on.
 */
export class FallbackIntentClassifier implements IntentClassifier {
  private readonly deferAtOrBelow: number;

  public constructor(
    private readonly primary: IntentClassifier,
    private readonly fallback: IntentClassifier,
    opts: FallbackIntentClassifierOptions = {},
  ) {
    this.deferAtOrBelow = opts.deferAtOrBelow ?? 0;
  }

  public async classify(intent: string, patterns: readonly string[]): Promise<number> {
    let primaryScore: number;
    try {
      primaryScore = await this.primary.classify(intent, patterns);
    } catch {
      // Primary (embedding) adapter unavailable — degrade to rules.
      return this.fallback.classify(intent, patterns);
    }
    if (primaryScore > this.deferAtOrBelow) {
      return primaryScore;
    }
    const fallbackScore = await this.fallback.classify(intent, patterns);
    return Math.max(primaryScore, fallbackScore);
  }
}

/** Distinct intent patterns across the catalog (the reindex input set). */
export function collectIntentPatterns(catalog: readonly InternalAgentDefinition[]): string[] {
  const patterns = new Set<string>();
  for (const def of catalog) {
    for (const pattern of def.intent_patterns) {
      patterns.add(pattern);
    }
  }
  return [...patterns];
}

/**
 * Reindex an embedding classifier over the whole catalog. Call at boot and
 * whenever the catalog changes (e.g. a new agent is added).
 *
 * NOTE: the cache is in-process, so "reindex" today means re-running this over
 * the running classifier. TODO(phase-5): persist pattern embeddings (pgvector)
 * so reindex becomes an offline job and the cache survives restarts.
 */
export async function reindexIntentClassifier(
  classifier: EmbeddingIntentClassifier,
  catalog: readonly InternalAgentDefinition[],
): Promise<number> {
  return classifier.index(collectIntentPatterns(catalog));
}
