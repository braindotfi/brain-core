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

import { scoreEvidence, type Evidence, type EvidenceBundle } from "@brain/internal-agents";
import type { RequiredEvidence } from "@brain/schemas";

export interface EvidenceQuery {
  readonly tenantId: string;
  readonly context?: Record<string, unknown>;
  readonly requiredEvidence: readonly RequiredEvidence[];
}

export interface EvidenceGatherer {
  gather(query: EvidenceQuery): Promise<EvidenceBundle>;
}

/** Fraction of required evidence kinds present among gathered items. */
export function evidenceCompleteness(
  items: readonly Evidence[],
  requiredEvidence: readonly RequiredEvidence[],
): number {
  return scoreEvidence(items, requiredEvidence).completeness;
}

/** Deterministic gatherer over a fixed evidence set. Used as a default and in tests. */
export class StaticEvidenceGatherer implements EvidenceGatherer {
  constructor(private readonly items: readonly Evidence[] = []) {}

  async gather(query: EvidenceQuery): Promise<EvidenceBundle> {
    return scoreEvidence(this.items, query.requiredEvidence);
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
    return scoreEvidence(items, query.requiredEvidence);
  }
}
