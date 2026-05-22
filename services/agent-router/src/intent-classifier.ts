/**
 * Intent classification.
 *
 * Phase 1 ships a deterministic rules-based classifier that scores a
 * free-form intent against an agent's declared `intent_patterns` by token
 * overlap. Phase 4 adds an embedding-based implementation (see
 * `EmbeddingIntentClassifier`) behind the same interface; the rules-based
 * classifier stays as the fallback.
 *
 * `classify` returns `number | Promise<number>` so a deterministic
 * implementation can stay synchronous while an embedding implementation can
 * await its adapter. Callers must `await` the result either way.
 */

export interface IntentClassifier {
  /** Returns a 0..1 match score of `intent` against the best pattern. */
  classify(intent: string, patterns: readonly string[]): number | Promise<number>;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export class RulesIntentClassifier implements IntentClassifier {
  classify(intent: string, patterns: readonly string[]): number {
    const intentTokens = new Set(tokenize(intent));
    if (intentTokens.size === 0) {
      return 0;
    }
    let best = 0;
    for (const pattern of patterns) {
      const patternTokens = tokenize(pattern);
      if (patternTokens.length === 0) {
        continue;
      }
      let matched = 0;
      for (const token of patternTokens) {
        if (intentTokens.has(token)) {
          matched += 1;
        }
      }
      // Fraction of the pattern's tokens present in the intent.
      const score = matched / patternTokens.length;
      if (score > best) {
        best = score;
      }
    }
    return best;
  }
}
