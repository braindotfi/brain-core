/**
 * Reconciliation scoring helpers.
 *
 * Each matcher mixes two or three signals into a confidence score:
 *   - amount agreement (decimal compare)
 *   - date proximity (days apart)
 *   - name / counterparty match (lexical)
 *
 * Scoring is deliberately simple at MVP. Phase-6 (or post-MVP) layers in
 * learned scorers behind the same interface.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function amountScore(a: string, b: string): number {
  if (!isFiniteDecimal(a) || !isFiniteDecimal(b)) return 0;
  const na = parseDecimal(a);
  const nb = parseDecimal(b);
  if (na === nb) return 1;
  // Allow up to 1% delta with a 0.5 score; bigger deltas drop quickly.
  const high = Math.max(Math.abs(na), Math.abs(nb), 1);
  const delta = Math.abs(na - nb) / high;
  if (delta < 0.001) return 0.95;
  if (delta < 0.01) return 0.6;
  if (delta < 0.05) return 0.2;
  return 0;
}

export function dateScore(left: Date, right: Date, windowDays = 7): number {
  const diff = Math.abs(left.getTime() - right.getTime()) / MS_PER_DAY;
  if (diff <= 0.5) return 1;
  if (diff <= 1) return 0.9;
  if (diff <= 3) return 0.7;
  if (diff <= windowDays) return 0.4;
  return 0;
}

/**
 * 1 if a == b after normalization; 0.7 on substring containment; 0.4 on a
 * reasonable token overlap; 0 otherwise.
 */
export function nameScore(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.7;
  const overlap = tokenOverlap(na, nb);
  return overlap >= 0.5 ? 0.4 : 0;
}

/** Combine signals with weights. Default weights sum to 1.0. */
export function combine(parts: Array<{ score: number; weight: number }>): number {
  let total = 0;
  let weightSum = 0;
  for (const p of parts) {
    total += p.score * p.weight;
    weightSum += p.weight;
  }
  return weightSum === 0 ? 0 : total / weightSum;
}

// ---------------------------------------------------------------------------

function isFiniteDecimal(s: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(s);
}

function parseDecimal(s: string): number {
  return Number.parseFloat(s);
}

function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter((t) => t.length > 1));
  const tb = new Set(b.split(/\s+/).filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / Math.min(ta.size, tb.size);
}
