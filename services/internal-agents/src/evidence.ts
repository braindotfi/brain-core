/**
 * Evidence shapes shared between internal-agent handlers (which consume a
 * bundle) and the router's evidence gatherer (which produces one). Kept here
 * so @brain/agent-router can depend on @brain/internal-agents without a cycle.
 */

export interface Evidence {
  readonly kind: string;
  readonly ref: string;
  readonly excerpt?: string;
}

export interface EvidenceBundle {
  readonly items: readonly Evidence[];
  /** Fraction of required evidence kinds present (0..1). */
  readonly completeness: number;
}
