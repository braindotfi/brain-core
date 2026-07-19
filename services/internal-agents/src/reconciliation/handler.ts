import {
  evidenceRefsForAction,
  policyConfidenceForEvidence,
  readString,
  requireCurrency,
  requireDecimalAmount,
  requireStringField,
  type HandlerInput,
  type InternalAgentHandler,
  type ProposedAction,
} from "../handler.js";

/** Reconciliation actions are non-financial proposals over Ledger reconciliation
 *  candidates; they go through IAgentService.propose. No money moves. */
export const reconciliationHandler: InternalAgentHandler = {
  agent_key: "reconciliation",
  actions: ["propose_match", "flag_discrepancy", "create_task", "no_match"],
  build(input: HandlerInput): ProposedAction {
    return buildReconciliationProposal(input);
  },
};

type CandidateKind = "invoice" | "obligation" | "transaction";

interface ReconciliationCandidate {
  readonly kind: CandidateKind;
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly date: string;
  readonly counterparty_id?: string | null;
  readonly counterparty_name?: string | null;
  readonly label?: string | null;
  readonly status?: string | null;
}

interface RankedCandidate extends ReconciliationCandidate {
  readonly score: number;
  readonly match_basis: readonly string[];
}

const CONFIDENCE_FLOOR = 0.7;

function buildReconciliationProposal(input: HandlerInput): ProposedAction {
  const transactionId = requireStringField(input.context, "transaction_id");
  const amount = requireDecimalAmount(input.context, "amount");
  const currency = requireCurrency(input.context, "currency");
  const transactionDate = requireStringField(input.context, "transaction_date");
  const direction = readString(input.context.direction, "unknown");
  const counterpartyId = readOptionalString(input.context.counterparty_id);
  const counterpartyName = readString(
    input.context.counterparty_name,
    counterpartyId ?? "unknown counterparty",
  );
  const candidates = readCandidates(input.context.candidates);
  const ranked = candidates
    .map((candidate) =>
      rankCandidate(candidate, { amount, currency, transactionDate, counterpartyId }),
    )
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const best = ranked[0];
  const matched = best !== undefined && best.score >= CONFIDENCE_FLOOR;
  const confidence = policyConfidenceForEvidence(input.evidence, input.confidence);
  const confidenceScore = matched
    ? best.score
    : Math.min(best?.score ?? 0, CONFIDENCE_FLOOR - 0.01);
  const matchType = matched ? "propose_match" : "no_match";
  const rightEntityId = matched ? best.id : null;
  const rightEntityKind = matched ? best.kind : null;
  const matchBasis = matched ? best.match_basis : (best?.match_basis ?? []);
  const explanation = matched
    ? `Transaction ${transactionId} matches ${best.kind} ${best.id} by ${matchBasis.join(", ")}.`
    : noMatchExplanation(transactionId, best);

  return {
    channel: "agent",
    action: {
      type: "reconciliation",
      kind: "agent_action",
      transaction_id: transactionId,
      amount,
      currency,
      direction,
      transaction_date: transactionDate,
      counterparty_id: counterpartyId,
      counterparty_name: counterpartyName,
      recommended_action: matchType,
      match_type: matchType,
      left_entity_type: "transaction",
      left_entity_id: transactionId,
      right_entity_type: rightEntityKind,
      right_entity_id: rightEntityId,
      confidence_score: roundScore(confidenceScore),
      match_basis: matchBasis,
      ranked_candidates: ranked.map((candidate) => ({
        kind: candidate.kind,
        id: candidate.id,
        amount: candidate.amount,
        currency: candidate.currency,
        date: candidate.date,
        counterparty_id: candidate.counterparty_id ?? null,
        counterparty_name: candidate.counterparty_name ?? null,
        label: candidate.label ?? null,
        status: candidate.status ?? null,
        score: candidate.score,
        match_basis: candidate.match_basis,
      })),
      explanation,
      narrative:
        `${counterpartyName} ${direction} transaction ${transactionId} for ${amount} ${currency} ` +
        `${matched ? `has a proposed ${rightEntityKind} match ${rightEntityId}` : "has no confident reconciliation match"}.`,
      summary: `${amount} ${currency} unreconciled transaction ${matched ? "has a proposed match" : "needs review"}.`,
      risk_band: matched ? "standard" : "elevated",
      confidence,
      evidence_score: input.evidence.evidence_score,
      risk_level: input.definition?.risk_level ?? null,
      agent_id: input.definition?.agent_key ?? "reconciliation",
      agent_role: input.definition?.agent_key ?? "reconciliation",
      evidence_refs: evidenceRefsForAction(input.evidence.items),
      missing_required_evidence: [...input.evidence.missing_required_evidence],
      critical_missing: input.evidence.critical_missing,
      mode: input.definition?.default_authority === "notify_only" ? "notify_only" : "propose",
    },
  };
}

function readCandidates(raw: unknown): ReconciliationCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(readCandidate)
    .filter((candidate): candidate is ReconciliationCandidate => candidate !== null);
}

function readCandidate(raw: unknown): ReconciliationCandidate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const kind = readString(row.kind);
  if (kind !== "invoice" && kind !== "obligation" && kind !== "transaction") return null;
  const id = readString(row.id);
  const amount = readString(row.amount);
  const currency = readString(row.currency).toUpperCase();
  const date = readString(row.date);
  if (id.length === 0 || amount.length === 0 || currency.length === 0 || date.length === 0) {
    return null;
  }
  return {
    kind,
    id,
    amount,
    currency,
    date,
    counterparty_id: readOptionalString(row.counterparty_id),
    counterparty_name: readOptionalString(row.counterparty_name),
    label: readOptionalString(row.label),
    status: readOptionalString(row.status),
  };
}

function rankCandidate(
  candidate: ReconciliationCandidate,
  tx: {
    readonly amount: string;
    readonly currency: string;
    readonly transactionDate: string;
    readonly counterpartyId?: string | null;
  },
): RankedCandidate {
  const basis: string[] = [];
  let score = 0;
  if (candidate.currency === tx.currency && decimalEqual(candidate.amount, tx.amount)) {
    score += 0.45;
    basis.push("amount_equal");
  }
  if (
    tx.counterpartyId !== undefined &&
    tx.counterpartyId !== null &&
    candidate.counterparty_id === tx.counterpartyId
  ) {
    score += 0.35;
    basis.push("counterparty_match");
  }
  const days = daysBetween(candidate.date, tx.transactionDate);
  if (days !== null) {
    if (days <= 1) {
      score += 0.2;
      basis.push("date_within_1_day");
    } else if (days <= 3) {
      score += 0.15;
      basis.push("date_within_3_days");
    } else if (days <= 7) {
      score += 0.1;
      basis.push("date_within_7_days");
    } else if (days <= 14) {
      score += 0.05;
      basis.push("date_within_14_days");
    }
  }
  return { ...candidate, score: roundScore(score), match_basis: basis };
}

function decimalEqual(left: string, right: string): boolean {
  return Number(left) === Number(right);
}

function daysBetween(left: string, right: string): number | null {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return null;
  return Math.floor(Math.abs(leftMs - rightMs) / 86_400_000);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function noMatchExplanation(transactionId: string, best: RankedCandidate | undefined): string {
  if (best === undefined) {
    return `Transaction ${transactionId} has no candidate reconciliation targets.`;
  }
  return `Transaction ${transactionId} has no candidate above confidence floor ${CONFIDENCE_FLOOR}; best candidate ${best.id} scored ${best.score}.`;
}

export function __reconciliationTestOnly(): { confidenceFloor: number } {
  return { confidenceFloor: CONFIDENCE_FLOOR };
}
