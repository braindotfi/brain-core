/**
 * A controlled, semantic-ish embedding adapter for tests.
 *
 * A real embedding model is non-deterministic and needs a network call, which
 * makes paraphrase tests flaky and slow. This stub maps each input to a vector
 * in a small "concept space": each axis counts how many of that concept's
 * trigger words appear in the input. Phrases about the same concept produce
 * (near-)parallel vectors — high cosine similarity — while phrases in different
 * concepts produce orthogonal vectors — cosine ~0. That lets paraphrase tests
 * assert deterministic, model-free routing.
 *
 * The concept word-bags are deliberately disjoint, so a phrase landing in one
 * concept is orthogonal to every other concept.
 */

import type { EmbeddingAdapter, EmbeddingResult } from "@brain/shared";

const CONCEPTS: Record<string, readonly string[]> = {
  // Collections — chasing money owed.
  collections: [
    "follow",
    "overdue",
    "invoice",
    "invoices",
    "chase",
    "late",
    "payment",
    "paying",
    "owe",
    "owes",
    "money",
    "clients",
    "remind",
    "unpaid",
    "receivable",
    "outstanding",
  ],
  // Treasury — moving idle cash to yield.
  treasury: [
    "sweep",
    "idle",
    "cash",
    "move",
    "excess",
    "balance",
    "yield",
    "invest",
    "surplus",
    "funds",
    "liquidity",
    "reserves",
  ],
  // Purchase advisor — should-I-buy decisions.
  purchase: [
    "should",
    "purchase",
    "buy",
    "buying",
    "good",
    "time",
    "laptop",
    "afford",
    "new",
    "worth",
  ],
  // Personal budget — tracking spending.
  budget: ["track", "monthly", "spending", "review", "budget", "manage", "expenses", "categorize"],
  // Travel finance — used only by the reindex test's new agent.
  travel: ["trip", "travel", "flight", "hotel", "vacation", "abroad", "itinerary"],
};

const CONCEPT_KEYS = Object.keys(CONCEPTS);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Deterministic, concept-based embedding adapter for tests. */
export class ConceptEmbeddingAdapter implements EmbeddingAdapter {
  public readonly defaultDimension = CONCEPT_KEYS.length;
  /** Number of embed() calls — lets tests assert caching. */
  public calls = 0;

  public async embed(input: string, model = "concept-test"): Promise<EmbeddingResult> {
    this.calls += 1;
    const tokens = new Set(tokenize(input));
    const vector = CONCEPT_KEYS.map((key) => {
      const words = CONCEPTS[key] ?? [];
      let count = 0;
      for (const word of words) {
        if (tokens.has(word)) {
          count += 1;
        }
      }
      return count;
    });
    return { vector, model, usage: { inputTokens: tokens.size } };
  }
}
