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

export function validateEvidence(input: EvidenceValidationInput): EvidenceValidationResult {
  const validator = VALIDATORS[input.actionType];
  // No registered validator for this action type ⇒ not applicable (additive;
  // semantic validators are registered per money-mover action type over time).
  if (validator === undefined) return { passed: true, failures: [] };
  const failures = validator(input);
  return { passed: failures.length === 0, failures };
}

const VALIDATORS: Readonly<Record<string, (i: EvidenceValidationInput) => Failure[]>> = {
  pay_invoice: validatePayInvoice,
  pay_obligation: validatePayObligation,
};

function validatePayInvoice(i: EvidenceValidationInput): Failure[] {
  const failures: Failure[] = [];
  const invoice = i.evidence.find((e) => e.kind === "invoice");
  if (invoice === undefined) {
    failures.push({ rule: "invoice_present", detail: "no evidence of kind 'invoice' attached" });
    return failures; // nothing else is checkable without the invoice
  }
  const x = invoice.extracted;

  if (
    i.paymentIntent.invoiceId !== undefined &&
    str(x.invoice_number) !== undefined &&
    str(x.invoice_number) !== i.paymentIntent.invoiceId
  ) {
    failures.push({
      rule: "invoice_number_match",
      detail: `invoice_number ${str(x.invoice_number)} != intent invoiceId ${i.paymentIntent.invoiceId}`,
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
  const status = str(x.status);
  if (status !== "open" && status !== "due_soon") {
    failures.push({
      rule: "obligation_status",
      detail: `obligation status is '${status ?? "(missing)"}', expected open|due_soon`,
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
