import { describe, expect, it } from "vitest";
import type { EmbeddingAdapter, EmbeddingResult } from "@brain/shared";
import type { InternalAgentDefinition } from "@brain/schemas";
import { RulesIntentClassifier } from "./intent-classifier.js";
import {
  collectIntentPatterns,
  cosineSimilarity,
  DEFAULT_EMBEDDING_MATCH_THRESHOLD,
  EmbeddingIntentClassifier,
  FallbackIntentClassifier,
  reindexIntentClassifier,
} from "./embedding-classifier.js";
import { ConceptEmbeddingAdapter } from "./concept-embedder.mock.js";

/** An adapter that returns a fixed vector per input string (for exact-angle tests). */
class FixedEmbeddingAdapter implements EmbeddingAdapter {
  public readonly defaultDimension: number;
  public constructor(private readonly table: Record<string, number[]>) {
    this.defaultDimension = 2;
  }
  public async embed(input: string): Promise<EmbeddingResult> {
    const vector = this.table[input] ?? [0, 0];
    return { vector, model: "fixed-test", usage: { inputTokens: 0 } };
  }
}

/** An adapter that always throws — simulates an unavailable embedding service. */
class FailingEmbeddingAdapter implements EmbeddingAdapter {
  public readonly defaultDimension = 2;
  public async embed(): Promise<EmbeddingResult> {
    throw new Error("embedding service unavailable");
  }
}

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });
  it("is 0 when either vector is degenerate (zero)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it("compares over the shorter length when dimensions differ", () => {
    expect(cosineSimilarity([1, 0, 99], [1, 0])).toBeCloseTo(1);
  });
});

describe("EmbeddingIntentClassifier", () => {
  it("matches a paraphrase in the same concept above the threshold", async () => {
    const c = new EmbeddingIntentClassifier(new ConceptEmbeddingAdapter());
    // "remind clients who owe us money" shares no tokens with the pattern, but
    // lands in the same concept → high cosine.
    const score = await c.classify("remind clients who owe us money", [
      "follow up on overdue invoice",
    ]);
    expect(score).toBeGreaterThanOrEqual(DEFAULT_EMBEDDING_MATCH_THRESHOLD);
  });

  it("returns 0 for a different concept (orthogonal)", async () => {
    const c = new EmbeddingIntentClassifier(new ConceptEmbeddingAdapter());
    const score = await c.classify("sweep idle cash into yield", ["follow up on overdue invoice"]);
    expect(score).toBe(0);
  });

  it("returns 0 just below the match threshold and the score just above it", async () => {
    // Build vectors with a known angle. cos(θ)=0.5 → below 0.55; cos≈0.6 → above.
    const below = new EmbeddingIntentClassifier(
      new FixedEmbeddingAdapter({
        intent: [1, 0],
        // angle 60° → cosine 0.5
        pattern: [0.5, Math.sqrt(3) / 2],
      }),
    );
    expect(await below.classify("intent", ["pattern"])).toBe(0);

    const above = new EmbeddingIntentClassifier(
      new FixedEmbeddingAdapter({
        intent: [1, 0],
        // cosine 0.6
        pattern: [0.6, 0.8],
      }),
    );
    expect(await above.classify("intent", ["pattern"])).toBeCloseTo(0.6);
  });

  it("returns 0 for empty patterns or empty intent", async () => {
    const c = new EmbeddingIntentClassifier(new ConceptEmbeddingAdapter());
    expect(await c.classify("anything", [])).toBe(0);
    expect(await c.classify("   ", ["follow up on overdue invoice"])).toBe(0);
  });

  it("caches pattern vectors: index() embeds once, repeats are free", async () => {
    const adapter = new ConceptEmbeddingAdapter();
    const c = new EmbeddingIntentClassifier(adapter);
    const indexed = await c.index(["follow up on overdue invoice", "chase late payment"]);
    expect(indexed).toBe(2);
    expect(adapter.calls).toBe(2);
    // Re-indexing the same patterns embeds nothing new.
    expect(await c.index(["follow up on overdue invoice", "chase late payment"])).toBe(0);
    expect(adapter.calls).toBe(2);
    // classify reuses the cached pattern vectors (one new call for the intent).
    await c.classify("remind clients who owe us money", ["follow up on overdue invoice"]);
    expect(adapter.calls).toBe(3);
  });
});

describe("FallbackIntentClassifier", () => {
  it("uses the embedding score when the primary recognizes the intent", async () => {
    const fallback = new FallbackIntentClassifier(
      new EmbeddingIntentClassifier(new ConceptEmbeddingAdapter()),
      new RulesIntentClassifier(),
    );
    const score = await fallback.classify("invest our surplus funds", ["sweep idle cash"]);
    expect(score).toBeGreaterThanOrEqual(DEFAULT_EMBEDDING_MATCH_THRESHOLD);
  });

  it("falls back to rules when the embedding classifier does not recognize the intent", async () => {
    // Token overlap exists (rules > 0) but the embedder is concept-blind to
    // these exact tokens, so the embedding score is 0 → rules wins.
    const fallback = new FallbackIntentClassifier(
      new EmbeddingIntentClassifier(new FixedEmbeddingAdapter({})), // every input → [0,0]
      new RulesIntentClassifier(),
    );
    const score = await fallback.classify("foo bar baz", ["foo bar baz"]);
    expect(score).toBe(1); // rules: full token overlap
  });

  it("degrades to rules when the embedding adapter throws", async () => {
    const fallback = new FallbackIntentClassifier(
      new EmbeddingIntentClassifier(new FailingEmbeddingAdapter()),
      new RulesIntentClassifier(),
    );
    const score = await fallback.classify("follow up overdue invoice", [
      "follow up overdue invoice",
    ]);
    expect(score).toBe(1);
  });
});

describe("catalog reindex helpers", () => {
  const defs: InternalAgentDefinition[] = [
    {
      agent_key: "a",
      display_name: "A",
      provenance: "internal",
      category: "business",
      capabilities: ["a"],
      triggers: [],
      intent_patterns: ["one", "two"],
      readable_data: [],
      risk_level: "low",
      minimum_confidence: 0.5,
      required_evidence: [],
      default_authority: "notify_only",
      enabled_by_default: true,
    },
    {
      agent_key: "b",
      display_name: "B",
      provenance: "internal",
      category: "consumer",
      capabilities: ["b"],
      triggers: [],
      intent_patterns: ["two", "three"], // "two" is shared → deduped
      readable_data: [],
      risk_level: "low",
      minimum_confidence: 0.5,
      required_evidence: [],
      default_authority: "notify_only",
      enabled_by_default: true,
    },
  ];

  it("collectIntentPatterns dedupes patterns across the catalog", () => {
    expect(collectIntentPatterns(defs).sort()).toEqual(["one", "three", "two"]);
  });

  it("reindexIntentClassifier embeds each distinct pattern once", async () => {
    const adapter = new ConceptEmbeddingAdapter();
    const c = new EmbeddingIntentClassifier(adapter);
    expect(await reindexIntentClassifier(c, defs)).toBe(3);
    expect(adapter.calls).toBe(3);
  });
});
