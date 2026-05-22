/**
 * Intent decomposition (Phase 4 stub).
 *
 * A single free-form intent can carry more than one action ("pay the invoice
 * and then sweep idle cash"). A decomposer splits one intent into the
 * sub-intents the router should classify independently. Phase 4 ships only the
 * identity decomposer (one intent in, one intent out) so the contract exists
 * and callers can adopt it without a behavior change.
 *
 * NOT wired into the router yet — adding it would change router selection,
 * which is out of scope for Phase 4. It is exported for downstream callers and
 * future phases.
 *
 * TODO(phase-5): implement a compound-intent splitter (LLM- or rules-based)
 * and route each sub-intent, then merge the per-sub-intent decisions.
 */

export interface IntentDecomposer {
  /** Split a free-form intent into one or more sub-intents. */
  decompose(intent: string): readonly string[] | Promise<readonly string[]>;
}

/** Identity decomposer: returns the intent unchanged as a single-element list. */
export class SingleIntentDecomposer implements IntentDecomposer {
  public decompose(intent: string): readonly string[] {
    return [intent];
  }
}
