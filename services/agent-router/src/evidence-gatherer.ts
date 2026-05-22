/**
 * Evidence gathering.
 *
 * Pulls Wiki citations and Ledger references for a tenant + context, and
 * reports completeness against the agent's required evidence kinds. Used by
 * the router (pre-routing evidence score) and by agents (grounded proposals).
 *
 * Providers are injected as narrow async functions so this module takes no
 * dependency on the Wiki/Ledger service implementations directly — the
 * composition root wires IWikiMemoryService / ILedgerService to them.
 */

import type { Evidence, EvidenceBundle } from "@brain/internal-agents";

export interface EvidenceQuery {
  readonly tenantId: string;
  readonly context?: Record<string, unknown>;
  readonly requiredEvidence: readonly string[];
}

export interface EvidenceGatherer {
  gather(query: EvidenceQuery): Promise<EvidenceBundle>;
}

/** Fraction of required evidence kinds present among gathered items. */
export function evidenceCompleteness(
  items: readonly Evidence[],
  requiredEvidence: readonly string[],
): number {
  if (requiredEvidence.length === 0) {
    return 1;
  }
  const present = new Set(items.map((i) => i.kind));
  let found = 0;
  for (const kind of requiredEvidence) {
    if (present.has(kind)) {
      found += 1;
    }
  }
  return found / requiredEvidence.length;
}

/** Deterministic gatherer over a fixed evidence set. Used as a default and in tests. */
export class StaticEvidenceGatherer implements EvidenceGatherer {
  constructor(private readonly items: readonly Evidence[] = []) {}

  async gather(query: EvidenceQuery): Promise<EvidenceBundle> {
    return {
      items: this.items,
      completeness: evidenceCompleteness(this.items, query.requiredEvidence),
    };
  }
}

export interface EvidenceProviders {
  /** Wiki citations relevant to the context (narrative recall). */
  readonly wiki?: (query: EvidenceQuery) => Promise<readonly Evidence[]>;
  /** Ledger references relevant to the context. */
  readonly ledger?: (query: EvidenceQuery) => Promise<readonly Evidence[]>;
}

/** Composes Wiki + Ledger evidence providers into one bundle. */
export class ServiceEvidenceGatherer implements EvidenceGatherer {
  constructor(private readonly providers: EvidenceProviders) {}

  async gather(query: EvidenceQuery): Promise<EvidenceBundle> {
    const [wiki, ledger] = await Promise.all([
      this.providers.wiki?.(query) ?? Promise.resolve([]),
      this.providers.ledger?.(query) ?? Promise.resolve([]),
    ]);
    const items = [...wiki, ...ledger];
    return { items, completeness: evidenceCompleteness(items, query.requiredEvidence) };
  }
}
