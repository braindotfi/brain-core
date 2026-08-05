/**
 * Project a `doc_obligation_v1` raw_parsed payload into canonical AP/AR records
 * (Phase 5, doc-obligation canonical home).
 *
 * RFC 0004's document_extractor lands a single obligation observation per
 * document (counterparty named, not id'd). It is low-trust: provenance
 * agent_contributed, confidence capped <= 0.5. Unlike the aggregator path the
 * worker supplies that trust via ProjectionCommon, so the canonical record and
 * its Ledger projection stay agent_contributed and the §6 gate still refuses
 * auto-execution on document-only evidence.
 *
 * One document => one obligation + the counterparty it names. The obligation's
 * source_natural_key is the raw artifact id (stable per document); the
 * counterparty's is the normalized name (so the same vendor named across
 * documents from this source dedups, while cross-source identity is left to
 * Phase-4 resolution -- link, don't merge).
 */

import {
  isLedgerObligationType,
  isPlausibleLedgerAmount,
  LEDGER_DECIMAL_AMOUNT_RE,
} from "@brain/shared";
import type { ProjectionCommon } from "./merge-accounting.js";
import {
  normalizeName,
  type CounterpartyUpsert,
  type ObligationDirection,
  type ObligationUpsert,
} from "./merge-apar.js";

/** The source_system stamped on canonical records derived from document extraction. */
export const DOCUMENT_SOURCE_SYSTEM = "document" as const;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function currency(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const up = s.toUpperCase();
  return /^[A-Z]{3}$/.test(up) ? up : null;
}

export interface DocProjection {
  counterparty: CounterpartyUpsert;
  obligation: ObligationUpsert;
}

/**
 * Map a doc_obligation_v1 payload to a canonical counterparty + obligation.
 * Returns null on a payload missing the essentials, an unrecognized `type`,
 * or a malformed `amount` (the worker records it as a skipped row rather
 * than projecting it -- see runDocObligationPass in worker.ts).
 *
 * F4: `type` and `amount` come straight from the RFC-0004 LLM/OCR document
 * extractor with no upstream vocabulary or numeric-format check (the
 * equivalent check in services/ledger/src/extractors/doc-obligation.ts
 * validates a different, now-inert path -- see that file's header comment).
 * This is the one unvalidated ingress every other obligation-producing
 * projector avoids by hard-coding an allowed literal, so it reuses the same
 * LEDGER_OBLIGATION_TYPES / LEDGER_DECIMAL_AMOUNT_RE (@brain/shared) that
 * extractor validates against, instead of duplicating the rule.
 */
export function projectDocObligation(
  payload: Record<string, unknown>,
  rawArtifactId: string,
  common: ProjectionCommon,
): DocProjection | null {
  const name = str(payload["counterparty_name"]);
  const direction = payload["direction"];
  const type = str(payload["type"]);
  const amount = str(payload["amount"]);
  if (name === null || amount === null || type === null) return null;
  if (direction !== "payable" && direction !== "receivable") return null;
  if (!isLedgerObligationType(type)) return null;
  if (!LEDGER_DECIMAL_AMOUNT_RE.test(amount) || !isPlausibleLedgerAmount(amount)) return null;

  const counterpartyKey = normalizeName(name) || name;
  const counterparty: CounterpartyUpsert = {
    sourceSystem: DOCUMENT_SOURCE_SYSTEM,
    sourceNaturalKey: counterpartyKey,
    name,
    normalizedName: normalizeName(name) || null,
    type: direction === "receivable" ? "customer" : "vendor",
    email: null,
    extensions: { document: { raw_artifact_id: rawArtifactId } },
    common,
  };

  const obligation: ObligationUpsert = {
    sourceSystem: DOCUMENT_SOURCE_SYSTEM,
    sourceNaturalKey: rawArtifactId,
    direction: direction as ObligationDirection,
    type,
    counterpartySourceKey: counterpartyKey,
    amount,
    currency: currency(payload["currency"]),
    issueDate: null,
    dueDate: str(payload["due_date"]),
    status: str(payload["status"]),
    extensions: {
      document: {
        raw_artifact_id: rawArtifactId,
        ...(str(payload["minimum_due"]) !== null ? { minimum_due: payload["minimum_due"] } : {}),
        ...(str(payload["recurrence"]) !== null ? { recurrence: payload["recurrence"] } : {}),
      },
    },
    common,
  };

  return { counterparty, obligation };
}
