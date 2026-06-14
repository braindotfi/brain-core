/**
 * Map a source system's chart-of-accounts classification string onto the
 * canonical AccountClassification enum. Pure and deterministic — the projector
 * (PR-B) calls this; anything unrecognized resolves to "unknown" rather than
 * guessing, so a new source's vocabulary surfaces as unknown instead of being
 * silently miscategorized.
 *
 * Source vocabularies seen so far (Merge normalizes most platforms to these):
 * ASSET, LIABILITY, EQUITY, INCOME/REVENUE, EXPENSE. The raw provider value is
 * always retained in extensions, so this normalization is never lossy.
 */

import type { AccountClassification } from "./types.js";

const CLASSIFICATION_MAP: Readonly<Record<string, AccountClassification>> = {
  asset: "asset",
  assets: "asset",
  liability: "liability",
  liabilities: "liability",
  equity: "equity",
  income: "revenue",
  revenue: "revenue",
  expense: "expense",
  expenses: "expense",
};

export function classifyAccount(raw: string | null | undefined): AccountClassification {
  if (raw === null || raw === undefined) return "unknown";
  const key = raw.trim().toLowerCase();
  return CLASSIFICATION_MAP[key] ?? "unknown";
}
