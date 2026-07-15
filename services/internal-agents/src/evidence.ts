/**
 * Evidence shapes shared between internal-agent handlers (which consume a
 * bundle) and the router's evidence gatherer (which produces one). Kept here
 * so @brain/agent-router can depend on @brain/internal-agents without a cycle.
 *
 * Agent Autonomy v3 (1a.4): evidence items are typed EvidenceRefs and the
 * bundle carries a weighted evidence_score plus missing/critical-missing
 * signals. `completeness` is retained unchanged for the router's selection
 * scoring (do not modify routing scoring — see plan 1a.1).
 */

import type { RequiredEvidence, RequiredEvidenceSpec } from "@brain/schemas";

/**
 * Typed evidence pointer. Identity/provenance fields are optional until the
 * Wiki/Ledger providers populate them.
 * TODO(agent-autonomy-v3): the spec lists source_system/object_type/object_id/
 * confidence/timestamp/hash as required; make them required once the
 * evidence-gathering providers emit fully-typed refs.
 */
export interface EvidenceRef {
  readonly kind: string;
  readonly ref: string;
  readonly source_system?: "ledger" | "raw" | "wiki" | "chainalysis" | string;
  readonly object_type?: string;
  readonly object_id?: string;
  /** 0..1 confidence in the evidence item. */
  readonly confidence?: number;
  /** ISO-8601 timestamp the evidence was produced/observed. */
  readonly timestamp?: string;
  /** Content hash of the evidence. */
  readonly hash?: string;
  /** Redacted excerpt (per the run's redaction policy). */
  readonly excerpt?: string;
  readonly field_refs?: readonly string[];
  /** Optional workflow risk signals carried by evidence providers. */
  readonly risk_flag?: boolean;
  readonly severity?: "low" | "medium" | "high" | "critical" | string;
  readonly risk_score?: number;
  /** Computed during scoring: true when older than its required max_age. */
  readonly stale?: boolean;
}

/** Backward-compatible alias for the typed evidence pointer. */
export type Evidence = EvidenceRef;

export interface EvidenceBundle {
  readonly items: readonly EvidenceRef[];
  /** Fraction of declared evidence kinds present (0..1). Router scoring input. */
  readonly completeness: number;
  /** Weighted evidence score (0..1); a present-but-stale item counts at 0.5x. */
  readonly evidence_score: number;
  /** Required kinds (required: true) with no present item. */
  readonly missing_required_evidence: readonly string[];
  /** True when any required kind is missing. */
  readonly critical_missing: boolean;
}

/**
 * Normalize required-evidence entries to weighted specs. A bare string becomes
 * `{ kind, weight: 1/N, required: true }` where N is the entry count.
 */
export function normalizeRequiredEvidence(
  required: readonly RequiredEvidence[],
): RequiredEvidenceSpec[] {
  const n = required.length;
  return required.map((r) =>
    typeof r === "string" ? { kind: r, weight: n === 0 ? 0 : 1 / n, required: true } : r,
  );
}

const MAX_AGE_UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
};

function parseMaxAgeMs(maxAge: string | undefined): number | null {
  if (maxAge === undefined) {
    return null;
  }
  const m = /^(\d+)([hd])$/.exec(maxAge.trim());
  if (m === null) {
    return null;
  }
  const unit = MAX_AGE_UNIT_MS[m[2]!];
  return unit === undefined ? null : Number(m[1]) * unit;
}

function isStale(item: EvidenceRef, spec: RequiredEvidenceSpec, now: number): boolean {
  if (item.stale === true) {
    return true;
  }
  const maxAgeMs = parseMaxAgeMs(spec.max_age);
  if (maxAgeMs === null || item.timestamp === undefined) {
    return false;
  }
  const ts = Date.parse(item.timestamp);
  if (Number.isNaN(ts)) {
    return false;
  }
  return now - ts > maxAgeMs;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Score gathered evidence against a definition's required-evidence specs.
 *   - completeness: fraction of declared kinds present (unweighted, router input)
 *   - evidence_score: weighted sum; a present-but-stale item counts at 0.5x
 *   - missing_required_evidence / critical_missing: required kinds with no item
 *
 * With no declared evidence, the bundle is fully satisfied (completeness and
 * evidence_score = 1, nothing missing).
 */
export function scoreEvidence(
  items: readonly EvidenceRef[],
  required: readonly RequiredEvidence[],
  now: number = Date.now(),
): EvidenceBundle {
  const specs = normalizeRequiredEvidence(required);
  if (specs.length === 0) {
    return {
      items,
      completeness: 1,
      evidence_score: 1,
      missing_required_evidence: [],
      critical_missing: false,
    };
  }
  const byKind = new Map(items.map((i) => [i.kind, i] as const));
  let score = 0;
  let present = 0;
  const missing: string[] = [];
  for (const spec of specs) {
    const item = byKind.get(spec.kind);
    if (item === undefined) {
      if (spec.required) {
        missing.push(spec.kind);
      }
      continue;
    }
    present += 1;
    score += spec.weight * (isStale(item, spec, now) ? 0.5 : 1);
  }
  return {
    items,
    completeness: present / specs.length,
    evidence_score: clamp01(score),
    missing_required_evidence: missing,
    critical_missing: missing.length > 0,
  };
}
