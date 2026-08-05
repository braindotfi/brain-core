/**
 * §6 gate check 9.5 — evidence semantic validation (H-21).
 *
 * Gate check 9 verifies the proposal carries evidence references of the right
 * KIND. This verifies the evidence actually SUPPORTS the action: amount,
 * counterparty, currency, freshness, and source trust must match — otherwise an
 * agent could attach a $500 invoice to a $50,000 payment and pass check 9.
 *
 * Pure + deterministic (decimal-string math, no f64; `now` injectable). It lives
 * in shared/src/gate so the gate can call it without a service dependency
 * (services/policy re-exports it under evidence-validator.ts per the spec). The
 * DB enrichment — fetching the raw_parsed `extracted` payloads and resolving
 * invoice_number/amount_paid against ledger_invoices — happens in the injected
 * `resolveEvidence` loader (services/policy), not here.
 */

export type TrustLevel = "high" | "medium" | "low";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ResolvedEvidence {
  id: string;
  kind: string;
  /** Structured fields from the raw_parsed row (already DB-enriched). */
  extracted: Record<string, unknown>;
  sourceArtifactId: string;
  capturedAt: Date;
  trustLevel: TrustLevel;
}

export interface EvidenceValidationInput {
  readonly actionType: string;
  readonly paymentIntent: {
    counterpartyId: string;
    amount: string; // decimal-string
    currency: string;
    invoiceId?: string;
    obligationId?: string;
  };
  readonly evidence: ReadonlyArray<ResolvedEvidence>;
  /** Action's max risk level (manifest field) — gates the source-trust rule. */
  readonly maxRiskLevel?: RiskLevel;
  /** Reference "now" for the freshness rule. Defaults to the current time. */
  readonly now?: Date;
  /** Freshness window in days (default 90). */
  readonly freshnessWindowDays?: number;
}

export interface EvidenceValidationResult {
  passed: boolean;
  failures: ReadonlyArray<{ rule: string; detail: string }>;
}

type Failure = { rule: string; detail: string };

const DEFAULT_FRESHNESS_DAYS = 90;

// Real production action_type values that move funds to a counterparty
// (services/execution/src/payment-intents/action-types.ts). pay_invoice and
// pay_obligation are pre-mapping action ROUTE names
// (services/execution/src/actions/routes.ts) that get translated to one of
// these rail types before a PaymentIntent is ever stored -- a stored intent's
// action_type is never pay_invoice/pay_obligation, so dispatching on those
// values here never matched a real intent (H-21 CI-miss). ach_inbound (money
// coming in) and erp_writeback (no money movement) are intentionally excluded.
const EVIDENCE_VALIDATED_ACTION_TYPES: ReadonlySet<string> = new Set([
  "ach_outbound",
  "wire",
  "onchain_transfer",
  "card_payment",
]);

export function validateEvidence(input: EvidenceValidationInput): EvidenceValidationResult {
  // Not a money-out rail ⇒ not applicable (additive; this check only governs
  // payments that could be sent to the wrong party / wrong amount).
  if (!EVIDENCE_VALIDATED_ACTION_TYPES.has(input.actionType)) {
    return { passed: true, failures: [] };
  }
  // The rail type alone can no longer tell us whether this is "paying an
  // invoice" or "settling an obligation" -- that distinction now lives on
  // which link field the intent carries. Neither carried ⇒ nothing to validate
  // evidence against (an ad-hoc payment with no invoice/obligation claim).
  let failures: Failure[];
  if (input.paymentIntent.invoiceId !== undefined) {
    failures = validatePayInvoice(input);
  } else if (input.paymentIntent.obligationId !== undefined) {
    failures = validatePayObligation(input);
  } else {
    return { passed: true, failures: [] };
  }
  return { passed: failures.length === 0, failures };
}

function validatePayInvoice(i: EvidenceValidationInput): Failure[] {
  const failures: Failure[] = [];
  const invoice = i.evidence.find((e) => e.kind === "invoice");
  if (invoice === undefined) {
    failures.push({ rule: "invoice_present", detail: "no evidence of kind 'invoice' attached" });
    return failures; // nothing else is checkable without the invoice
  }
  const x = invoice.extracted;

  // paymentIntent.invoiceId is the ledger_invoices PRIMARY KEY (inv_<ulid>,
  // see isBrainId(invoiceId, "inv") at the P0.5 shortcut), not the
  // human-readable invoice_number business label -- the loader must resolve
  // and attach that PK as extracted.id for this comparison to be meaningful.
  if (
    i.paymentIntent.invoiceId !== undefined &&
    str(x.id) !== undefined &&
    str(x.id) !== i.paymentIntent.invoiceId
  ) {
    failures.push({
      rule: "invoice_id_match",
      detail: `evidence invoice id ${str(x.id)} != intent invoiceId ${i.paymentIntent.invoiceId}`,
    });
  }
  if (str(x.counterparty_id) !== i.paymentIntent.counterpartyId) {
    failures.push({
      rule: "counterparty_match",
      detail: `invoice counterparty ${str(x.counterparty_id)} != intent ${i.paymentIntent.counterpartyId}`,
    });
  }
  if (str(x.currency) !== i.paymentIntent.currency) {
    failures.push({
      rule: "currency_match",
      detail: `invoice currency ${str(x.currency)} != intent ${i.paymentIntent.currency}`,
    });
  }
  // amount_due minus already-paid must equal the intent amount (exact decimal).
  const amountDue = str(x.amount_due);
  if (amountDue === undefined) {
    failures.push({ rule: "amount_match", detail: "invoice has no amount_due" });
  } else {
    const paid = str(x.amount_paid) ?? "0";
    const remaining = subtractDecimal(amountDue, paid);
    if (compareDecimal(remaining, i.paymentIntent.amount) !== 0) {
      failures.push({
        rule: "amount_match",
        detail: `invoice remaining ${remaining} != intent amount ${i.paymentIntent.amount}`,
      });
    }
  }
  pushFreshness(failures, invoice, i);
  pushTrust(failures, invoice, i);
  return failures;
}

function validatePayObligation(i: EvidenceValidationInput): Failure[] {
  const failures: Failure[] = [];
  const ref = i.evidence.find((e) => e.kind === "obligation_reference" || e.kind === "invoice");
  if (ref === undefined) {
    failures.push({
      rule: "obligation_reference_present",
      detail: "no obligation_reference or invoice evidence attached",
    });
    return failures;
  }
  const x = ref.extracted;
  if (str(x.counterparty_id) !== i.paymentIntent.counterpartyId) {
    failures.push({
      rule: "counterparty_match",
      detail: `obligation counterparty ${str(x.counterparty_id)} != intent ${i.paymentIntent.counterpartyId}`,
    });
  }
  const amountDue = str(x.amount_due);
  if (amountDue === undefined || compareDecimal(amountDue, i.paymentIntent.amount) !== 0) {
    failures.push({
      rule: "amount_match",
      detail: `obligation amount_due ${amountDue ?? "(missing)"} != intent amount ${i.paymentIntent.amount}`,
    });
  }
  // Real ledger_obligations.status values (services/ledger/migrations/0007):
  // upcoming|due|paid|overdue|cancelled|disputed. 'open'/'due_soon' never
  // existed anywhere in this codebase, so this check was unsatisfiable by any
  // real row before this fix. upcoming/due/overdue are still payable; paid,
  // cancelled, and disputed are not (blocks paying an already-settled,
  // cancelled, or disputed obligation again).
  const status = str(x.status);
  if (status !== "upcoming" && status !== "due" && status !== "overdue") {
    failures.push({
      rule: "obligation_status",
      detail: `obligation status is '${status ?? "(missing)"}', expected upcoming|due|overdue`,
    });
  }
  pushTrust(failures, ref, i);
  return failures;
}

function pushFreshness(
  failures: Failure[],
  ev: ResolvedEvidence,
  i: EvidenceValidationInput,
): void {
  const now = i.now ?? new Date();
  const windowDays = i.freshnessWindowDays ?? DEFAULT_FRESHNESS_DAYS;
  const ageDays = (now.getTime() - ev.capturedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > windowDays) {
    failures.push({
      rule: "freshness",
      detail: `evidence captured ${Math.round(ageDays)}d ago, window is ${windowDays}d`,
    });
  }
}

function pushTrust(failures: Failure[], ev: ResolvedEvidence, i: EvidenceValidationInput): void {
  const lowRisk = i.maxRiskLevel === "low" || i.maxRiskLevel === "medium";
  if (ev.trustLevel !== "high" && !lowRisk) {
    failures.push({
      rule: "source_trust",
      detail: `source trust '${ev.trustLevel}' insufficient for max_risk_level '${i.maxRiskLevel ?? "high"}'`,
    });
  }
}

/**
 * Provenances that count as independently corroborated for the low-trust
 * auto-execution rule. Mirrors INDEPENDENT_PROVENANCE in the Ledger's
 * reconciliation persist step, which promotes corroborated obligations
 * `agent_contributed` → `extracted`.
 */
const CORROBORATED_PROVENANCE = new Set(["extracted", "human_confirmed"]);

export interface LowTrustAutoExecutionInput {
  /** Policy outcome for this intent (known at check 3). */
  readonly outcome: "allow" | "confirm" | "reject";
  readonly evidence: ReadonlyArray<ResolvedEvidence>;
  /**
   * Provenance of the linked obligation, when one exists and the loader is
   * wired; null otherwise. A corroborated obligation (promoted to
   * `extracted`) keeps low-trust document evidence eligible.
   */
  readonly obligationProvenance: string | null;
}

/**
 * Phase 2 trust contract (ingestion architecture §15): the gate refuses
 * AUTO-execution of a write rail when the supporting evidence is entirely
 * low-trust (`customer_asserted` generic push, or uncorroborated
 * `agent_contributed` document extraction).
 *
 * - outcome `confirm` is untouched: a human approval flow may proceed on
 *   document-only evidence (check 11 enforces the approval itself);
 * - intents with no evidence attached are governed by check 9, not here;
 * - any single higher-trust observation (provider webhook, authenticated
 *   pull) makes the set eligible — the refusal targets document-ONLY
 *   auto-execution;
 * - a linked obligation that reconciliation has corroborated (provenance
 *   promoted to `extracted`) is eligible even on document-only evidence.
 *
 * Deterministic, pure; fails closed when the obligation provenance is
 * unknown.
 */
export function validateLowTrustAutoExecution(
  i: LowTrustAutoExecutionInput,
): EvidenceValidationResult {
  if (i.outcome !== "allow" || i.evidence.length === 0) return { passed: true, failures: [] };
  const allLowTrust = i.evidence.every((e) => e.trustLevel === "low");
  if (!allLowTrust) return { passed: true, failures: [] };
  if (i.obligationProvenance !== null && CORROBORATED_PROVENANCE.has(i.obligationProvenance)) {
    return { passed: true, failures: [] };
  }
  return {
    passed: false,
    failures: [
      {
        rule: "low_trust_auto_execution",
        detail:
          "auto-execution refused: all supporting evidence is low-trust " +
          "(customer_asserted / uncorroborated agent_contributed) and the linked " +
          "obligation is not corroborated; require approval (confirm) or corroborate " +
          "the obligation against an independent source",
      },
    ],
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// --- decimal-string helpers (no f64; 18 fractional digits) ------------------

interface NormDec {
  negative: boolean;
  int: string;
  frac: string;
}

function norm(s: string): NormDec {
  let str0 = s.trim();
  const negative = str0.startsWith("-");
  if (negative) str0 = str0.slice(1);
  const [intRaw, fracRaw = ""] = str0.split(".");
  return {
    negative,
    int: (intRaw ?? "").replace(/^0+/, "") || "0",
    frac: fracRaw.padEnd(18, "0").slice(0, 18),
  };
}

export function compareDecimal(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  const ia = BigInt((na.negative ? "-" : "") + na.int + na.frac);
  const ib = BigInt((nb.negative ? "-" : "") + nb.int + nb.frac);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** a - b as a decimal string (may be negative). */
export function subtractDecimal(a: string, b: string): string {
  const na = norm(a);
  const nb = norm(b);
  const ia = BigInt((na.negative ? "-" : "") + na.int + na.frac);
  const ib = BigInt((nb.negative ? "-" : "") + nb.int + nb.frac);
  const diff = ia - ib;
  const neg = diff < 0n;
  const abs = (neg ? -diff : diff).toString().padStart(19, "0");
  const intPart = abs.slice(0, abs.length - 18).replace(/^0+/, "") || "0";
  const fracPart = abs.slice(abs.length - 18).replace(/0+$/, "");
  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return neg && body !== "0" ? `-${body}` : body;
}
