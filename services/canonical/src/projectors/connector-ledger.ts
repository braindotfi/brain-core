import type { ProjectionCommon } from "./merge-accounting.js";
import type { CounterpartyUpsert, ObligationUpsert } from "./merge-apar.js";
import { normalizeName } from "./merge-apar.js";

export const PLAID_LEDGER_PARSER = "plaid_tx_v1" as const;
export const STRIPE_LEDGER_PARSER = "stripe_v1" as const;
export const FINCH_LEDGER_PARSER = "finch_payroll_v1" as const;
export const BANK_STATEMENT_UPLOAD_PARSER = "bank_statement_upload_v1" as const;
export const DOCUMENT_RECORDS_UPLOAD_PARSER = "document_records_upload_v1" as const;

export const PLAID_LEDGER_PROJECTOR = "plaid_canonical_ledger_v1" as const;
export const STRIPE_LEDGER_PROJECTOR = "stripe_canonical_ledger_v1" as const;
export const FINCH_LEDGER_PROJECTOR = "finch_canonical_ledger_v1" as const;
export const BANK_STATEMENT_UPLOAD_PROJECTOR = "bank_statement_upload_canonical_v1" as const;
export const DOCUMENT_RECORDS_UPLOAD_PROJECTOR = "document_records_upload_canonical_v1" as const;

export interface CanonicalAccountUpsert {
  sourceSystem: string;
  sourceNaturalKey: string;
  institution: string | null;
  externalAccountId: string | null;
  accountType: string;
  name: string;
  currency: string;
  currentBalance: string | null;
  availableBalance: string | null;
  status: string;
  extensions: Record<string, unknown>;
  common: ProjectionCommon;
}

export interface CanonicalTransactionUpsert {
  sourceSystem: string;
  sourceNaturalKey: string;
  accountSourceKey: string | null;
  counterpartySourceKey: string | null;
  amount: string;
  currency: string;
  direction: string;
  transactionDate: string;
  postedDate: string | null;
  status: string;
  descriptionRaw: string | null;
  descriptionNormalized: string | null;
  reconciliationStatus: string | null;
  extensions: Record<string, unknown>;
  common: ProjectionCommon;
}

export type ConnectorLedgerProjection =
  | { kind: "account"; input: CanonicalAccountUpsert }
  | { kind: "transaction"; input: CanonicalTransactionUpsert }
  | { kind: "counterparty"; input: CounterpartyUpsert }
  | { kind: "obligation"; input: ObligationUpsert };

export interface ConnectorProjectionDiagnostics {
  skippedRows: Record<string, number>;
}

function skipped(diag: ConnectorProjectionDiagnostics | undefined, reason: string): void {
  if (diag === undefined) return;
  diag.skippedRows[reason] = (diag.skippedRows[reason] ?? 0) + 1;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function currency(v: unknown, fallback = "USD"): string {
  const s = str(v);
  const up = (s ?? fallback).toUpperCase();
  if (!/^[A-Z]{3}$/.test(up)) throw new Error("currency must be a 3-letter ISO 4217 code");
  return up;
}

function decimal(v: unknown): string | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    const s = String(v);
    return /[eE]/.test(s) ? null : s;
  }
  if (typeof v === "string") {
    const s = v.trim();
    return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
  }
  return null;
}

function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error("minor currency amount must be an integer");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function positiveDecimalFromCents(v: unknown): string | null {
  const cents = int(v);
  if (cents === null) return null;
  return centsToDecimal(Math.abs(cents));
}

function plaidAccountType(type: string | null, subtype: string | null): string {
  if (type === "depository" && subtype === "savings") return "bank_savings";
  if (type === "depository") return "bank_checking";
  if (type === "credit" && subtype === "line of credit") return "line_of_credit";
  if (type === "credit") return "card";
  if (type === "loan") return "loan";
  return "bank_checking";
}

function commonWithConfidence(common: ProjectionCommon, confidence: number): ProjectionCommon {
  return { ...common, confidence };
}

function commonWithParserConfidence(common: ProjectionCommon): ProjectionCommon {
  return { ...common, confidence: common.confidence ?? 0.5 };
}

export function projectPlaidLedger(
  extracted: unknown,
  common: ProjectionCommon,
  diag?: ConnectorProjectionDiagnostics,
): ConnectorLedgerProjection[] {
  const payload = asRecord(extracted);
  if (payload === null) throw new Error("plaid payload must be an object");
  const out: ConnectorLedgerProjection[] = [];
  const accounts = Array.isArray(payload["accounts"]) ? payload["accounts"] : [];
  const transactions = Array.isArray(payload["transactions"]) ? payload["transactions"] : [];

  for (const raw of accounts) {
    const acct = asRecord(raw);
    const key = str(acct?.["account_id"]);
    if (acct === null || key === null) {
      skipped(diag, "plaid_account_missing_id");
      continue;
    }
    out.push({
      kind: "account",
      input: {
        sourceSystem: "plaid",
        sourceNaturalKey: key,
        institution: str(payload["institution_name"]) ?? "Plaid",
        externalAccountId: key,
        accountType: plaidAccountType(str(acct["type"]), str(acct["subtype"])),
        name: str(acct["name"]) ?? key,
        currency: currency(acct["iso_currency_code"]),
        currentBalance: decimal(asRecord(acct["balances"])?.["current"]),
        availableBalance: decimal(asRecord(acct["balances"])?.["available"]),
        status: "active",
        extensions: { plaid: acct },
        common: commonWithConfidence(common, 0.95),
      },
    });
  }

  for (const raw of transactions) {
    const tx = asRecord(raw);
    const key = str(tx?.["transaction_id"]);
    const accountKey = str(tx?.["account_id"]);
    const amount = num(tx?.["amount"]);
    const date = str(tx?.["date"]);
    if (tx === null || key === null || accountKey === null || amount === null || date === null) {
      skipped(diag, "plaid_transaction_missing_required_field");
      continue;
    }
    const merchantName = str(tx["merchant_name"]) ?? str(tx["name"]);
    const counterpartyKey =
      merchantName === null ? null : `merchant:${normalizeName(merchantName) || merchantName}`;
    if (merchantName !== null && counterpartyKey !== null) {
      out.push({
        kind: "counterparty",
        input: {
          sourceSystem: "plaid",
          sourceNaturalKey: counterpartyKey,
          name: merchantName,
          normalizedName: normalizeName(merchantName) || null,
          type: "merchant",
          email: null,
          extensions: { plaid: { merchant_name: merchantName } },
          common: commonWithConfidence(common, 0.7),
        },
      });
    }
    out.push({
      kind: "transaction",
      input: {
        sourceSystem: "plaid",
        sourceNaturalKey: key,
        accountSourceKey: accountKey,
        counterpartySourceKey: counterpartyKey,
        amount: centsToDecimal(Math.round(Math.abs(amount) * 100)),
        currency: currency(tx["iso_currency_code"]),
        direction: amount >= 0 ? "outflow" : "inflow",
        transactionDate: date,
        postedDate: str(tx["authorized_date"]),
        status: tx["pending"] === true ? "pending" : "posted",
        descriptionRaw: str(tx["name"]),
        descriptionNormalized: merchantName,
        reconciliationStatus: "unreconciled",
        extensions: { plaid: tx },
        common: commonWithConfidence(common, 0.9),
      },
    });
  }

  return out;
}

export function projectStripeLedger(
  extracted: unknown,
  common: ProjectionCommon,
  diag?: ConnectorProjectionDiagnostics,
): ConnectorLedgerProjection[] {
  const payload = asRecord(extracted);
  if (payload === null) throw new Error("stripe payload must be an object");
  const objectType = str(payload["object_type"]);
  const stripeAccountId = str(payload["stripe_account_id"]) ?? "platform";
  const objects = Array.isArray(payload["objects"]) ? payload["objects"] : [];
  if (objectType === null) throw new Error("stripe payload missing object_type");
  const out: ConnectorLedgerProjection[] = [];

  const account: ConnectorLedgerProjection = {
    kind: "account",
    input: {
      sourceSystem: "stripe",
      sourceNaturalKey: stripeAccountId,
      institution: "Stripe",
      externalAccountId: stripeAccountId,
      accountType: "payment_processor",
      name: "Stripe Balance",
      currency: "USD",
      currentBalance: null,
      availableBalance: null,
      status: "active",
      extensions: { stripe_account_id: stripeAccountId },
      common: commonWithConfidence(common, 0.95),
    },
  };

  if (["charge", "payout", "refund", "balance_transaction"].includes(objectType)) {
    out.push(account);
  }

  for (const raw of objects) {
    const obj = asRecord(raw);
    const id = str(obj?.["id"]);
    if (obj === null || id === null) {
      skipped(diag, "stripe_object_missing_id");
      continue;
    }
    if (objectType === "customer") {
      const email = str(obj["email"]);
      const name = str(obj["name"]) ?? email ?? id;
      out.push({
        kind: "counterparty",
        input: {
          sourceSystem: "stripe",
          sourceNaturalKey: `customer:${id}`,
          name,
          normalizedName: normalizeName(name) || null,
          type: "customer",
          email,
          extensions: { stripe: obj },
          common: commonWithConfidence(common, 0.7),
        },
      });
    } else if (objectType === "charge" || objectType === "payout" || objectType === "refund") {
      const amount = positiveDecimalFromCents(obj["amount"]);
      if (amount === null) {
        skipped(diag, `stripe_${objectType}_missing_amount`);
        continue;
      }
      out.push({
        kind: "transaction",
        input: {
          sourceSystem: "stripe",
          sourceNaturalKey: id,
          accountSourceKey: stripeAccountId,
          counterpartySourceKey:
            typeof obj["customer"] === "string" ? `customer:${String(obj["customer"])}` : null,
          amount,
          currency: currency(obj["currency"]),
          direction: objectType === "charge" ? "inflow" : "outflow",
          transactionDate: new Date((num(obj["created"]) ?? 0) * 1000).toISOString(),
          postedDate: null,
          status: objectType === "charge" && obj["paid"] === false ? "pending" : "posted",
          descriptionRaw: str(obj["description"]),
          descriptionNormalized: objectType,
          reconciliationStatus: "unreconciled",
          extensions: { stripe: obj },
          common: commonWithConfidence(common, 0.9),
        },
      });
    } else if (objectType === "balance_transaction") {
      const type = str(obj["type"]);
      if (type !== "stripe_fee" && type !== "fee") {
        skipped(diag, "stripe_balance_transaction_not_fee");
        continue;
      }
      const amount = positiveDecimalFromCents(obj["fee"] ?? obj["amount"]);
      if (amount === null) {
        skipped(diag, "stripe_balance_transaction_missing_amount");
        continue;
      }
      out.push({
        kind: "transaction",
        input: {
          sourceSystem: "stripe",
          sourceNaturalKey: id,
          accountSourceKey: stripeAccountId,
          counterpartySourceKey: null,
          amount,
          currency: currency(obj["currency"]),
          direction: "outflow",
          transactionDate: new Date((num(obj["created"]) ?? 0) * 1000).toISOString(),
          postedDate: null,
          status: "posted",
          descriptionRaw: str(obj["description"]),
          descriptionNormalized: "Stripe fee",
          reconciliationStatus: "unreconciled",
          extensions: { stripe: obj },
          common: commonWithConfidence(common, 0.9),
        },
      });
    } else if (objectType === "dispute") {
      const amount = positiveDecimalFromCents(obj["amount"]);
      if (amount === null) {
        skipped(diag, "stripe_dispute_missing_amount");
        continue;
      }
      out.push({
        kind: "counterparty",
        input: {
          sourceSystem: "stripe",
          sourceNaturalKey: `processor:${stripeAccountId}`,
          name: "Stripe",
          normalizedName: "stripe",
          type: "other",
          email: null,
          extensions: { stripe_account_id: stripeAccountId },
          common: commonWithConfidence(common, 0.8),
        },
      });
      out.push({
        kind: "obligation",
        input: {
          sourceSystem: "stripe",
          sourceNaturalKey: `dispute:${id}`,
          direction: "payable",
          type: "dispute",
          counterpartySourceKey: `processor:${stripeAccountId}`,
          amount,
          currency: currency(obj["currency"]),
          issueDate: null,
          dueDate: null,
          status: str(obj["status"]),
          extensions: { stripe: obj },
          common: commonWithConfidence(common, 0.8),
        },
      });
    }
  }

  return out;
}

export function projectFinchLedger(
  extracted: unknown,
  common: ProjectionCommon,
  diag?: ConnectorProjectionDiagnostics,
): ConnectorLedgerProjection[] {
  const payload = asRecord(extracted);
  if (payload === null) throw new Error("finch payload must be an object");
  const objectType = str(payload["object_type"]);
  const objects = Array.isArray(payload["objects"]) ? payload["objects"] : [];
  if (objectType === null) throw new Error("finch payload missing object_type");
  const out: ConnectorLedgerProjection[] = [];

  if (objectType === "individual") {
    for (const raw of objects) {
      const obj = asRecord(raw);
      const id = str(obj?.["id"]);
      if (obj === null || id === null) {
        skipped(diag, "finch_individual_missing_id");
        continue;
      }
      const first = str(obj["first_name"]);
      const last = str(obj["last_name"]);
      const name = [first, last].filter(Boolean).join(" ") || id;
      out.push({
        kind: "counterparty",
        input: {
          sourceSystem: "finch",
          sourceNaturalKey: `individual:${id}`,
          name,
          normalizedName: normalizeName(name) || null,
          type: "employee",
          email: str(obj["email"]),
          extensions: { finch: obj },
          common: commonWithConfidence(common, 0.8),
        },
      });
    }
    return out;
  }

  if (objectType !== "pay_run") {
    skipped(diag, "finch_unsupported_object_type");
    return out;
  }

  out.push({
    kind: "account",
    input: {
      sourceSystem: "finch",
      sourceNaturalKey: "finch_payroll",
      institution: "Finch",
      externalAccountId: "finch_payroll",
      accountType: "payment_processor",
      name: "Payroll (Finch)",
      currency: "USD",
      currentBalance: null,
      availableBalance: null,
      status: "active",
      extensions: { finch_account: true },
      common: commonWithConfidence(common, 0.95),
    },
  });

  for (const raw of objects) {
    const obj = asRecord(raw);
    const id = str(obj?.["id"]);
    const payDate = str(obj?.["pay_date"]) ?? str(obj?.["payment_date"]);
    const amount = positiveDecimalFromCents(
      asRecord(obj?.["company_debit"])?.["amount"] ?? asRecord(obj?.["net_pay"])?.["amount"],
    );
    if (obj === null || id === null || payDate === null || amount === null) {
      skipped(diag, "finch_pay_run_missing_required_field");
      continue;
    }
    if (new Date(payDate).getTime() <= Date.now()) {
      out.push({
        kind: "transaction",
        input: {
          sourceSystem: "finch",
          sourceNaturalKey: `pay_run:${id}`,
          accountSourceKey: "finch_payroll",
          counterpartySourceKey: null,
          amount,
          currency: "USD",
          direction: "outflow",
          transactionDate: payDate,
          postedDate: payDate,
          status: "posted",
          descriptionRaw: str(obj["description"]) ?? "Payroll run",
          descriptionNormalized: "Payroll run",
          reconciliationStatus: "unreconciled",
          extensions: { finch: obj },
          common: commonWithConfidence(common, 0.9),
        },
      });
    } else {
      out.push({
        kind: "counterparty",
        input: {
          sourceSystem: "finch",
          sourceNaturalKey: "processor:finch_payroll",
          name: "Payroll (Finch)",
          normalizedName: "payroll_finch",
          type: "other",
          email: null,
          extensions: { finch_account: true },
          common: commonWithConfidence(common, 0.8),
        },
      });
      out.push({
        kind: "obligation",
        input: {
          sourceSystem: "finch",
          sourceNaturalKey: `pay_run:${id}`,
          direction: "payable",
          type: "payroll",
          counterpartySourceKey: "processor:finch_payroll",
          amount,
          currency: "USD",
          issueDate: null,
          dueDate: payDate,
          status: "upcoming",
          extensions: { finch: obj },
          common: commonWithConfidence(common, 0.85),
        },
      });
    }
  }
  return out;
}

export function projectBankStatementUploadLedger(
  extracted: unknown,
  common: ProjectionCommon,
  diag?: ConnectorProjectionDiagnostics,
): ConnectorLedgerProjection[] {
  const payload = asRecord(extracted);
  if (payload === null) throw new Error("bank statement upload payload must be an object");
  if (str(payload["object_type"]) !== "bank_statement") {
    throw new Error("bank statement upload payload missing object_type=bank_statement");
  }
  const account = asRecord(payload["account"]);
  const accountId = str(account?.["account_id"]);
  const transactions = Array.isArray(payload["transactions"]) ? payload["transactions"] : [];
  if (account === null || accountId === null) {
    throw new Error("bank statement upload payload missing account.account_id");
  }
  const sourceCommon = commonWithParserConfidence(common);
  const out: ConnectorLedgerProjection[] = [
    {
      kind: "account",
      input: {
        sourceSystem: "document_upload",
        sourceNaturalKey: accountId,
        institution: str(account["institution"]) ?? "Uploaded statement",
        externalAccountId: accountId,
        accountType: "bank_checking",
        name: str(account["name"]) ?? "Uploaded bank statement",
        currency: currency(account["currency"]),
        currentBalance: decimal(account["current_balance"]),
        availableBalance: null,
        status: "active",
        extensions: { document_upload: { object_type: "bank_statement", account } },
        common: sourceCommon,
      },
    },
  ];

  for (const raw of transactions) {
    const tx = asRecord(raw);
    const key = str(tx?.["transaction_id"]);
    const amount = decimal(tx?.["amount"]);
    const date = str(tx?.["date"]);
    const direction = str(tx?.["direction"]);
    if (
      tx === null ||
      key === null ||
      amount === null ||
      date === null ||
      (direction !== "inflow" && direction !== "outflow")
    ) {
      skipped(diag, "bank_statement_transaction_missing_required_field");
      continue;
    }
    const counterpartyName = str(tx["counterparty_name"]);
    const counterpartyKey =
      counterpartyName === null ? null : `upload_counterparty:${normalizeName(counterpartyName)}`;
    if (counterpartyName !== null && counterpartyKey !== null) {
      out.push({
        kind: "counterparty",
        input: {
          sourceSystem: "document_upload",
          sourceNaturalKey: counterpartyKey,
          name: counterpartyName,
          normalizedName: normalizeName(counterpartyName) || null,
          type: "merchant",
          email: null,
          extensions: { document_upload: { object_type: "bank_statement" } },
          common: sourceCommon,
        },
      });
    }
    out.push({
      kind: "transaction",
      input: {
        sourceSystem: "document_upload",
        sourceNaturalKey: key,
        accountSourceKey: accountId,
        counterpartySourceKey: counterpartyKey,
        amount,
        currency: currency(tx["currency"]),
        direction,
        transactionDate: date,
        postedDate: date,
        status: "posted",
        descriptionRaw: str(tx["description"]),
        descriptionNormalized: counterpartyName ?? str(tx["description"]),
        reconciliationStatus: "unreconciled",
        extensions: { document_upload: tx },
        common: sourceCommon,
      },
    });
  }

  return out;
}

export function projectDocumentRecordsUploadLedger(
  extracted: unknown,
  common: ProjectionCommon,
  diag?: ConnectorProjectionDiagnostics,
): ConnectorLedgerProjection[] {
  const payload = asRecord(extracted);
  if (payload === null) throw new Error("document records upload payload must be an object");
  const objectType = str(payload["object_type"]);
  if (objectType === "ar_aging") return projectArAging(payload, common, diag);
  if (objectType === "payroll_register") return projectPayrollRegister(payload, common, diag);
  throw new Error("document records upload payload has unsupported object_type");
}

function projectArAging(
  payload: Record<string, unknown>,
  common: ProjectionCommon,
  diag?: ConnectorProjectionDiagnostics,
): ConnectorLedgerProjection[] {
  const receivables = Array.isArray(payload["receivables"]) ? payload["receivables"] : [];
  const sourceCommon = commonWithParserConfidence(common);
  const out: ConnectorLedgerProjection[] = [];
  for (const raw of receivables) {
    const obj = asRecord(raw);
    const name = str(obj?.["counterparty_name"]);
    const invoiceRef = str(obj?.["invoice_ref"]);
    const amount = decimal(obj?.["amount"]);
    if (obj === null || name === null || invoiceRef === null || amount === null) {
      skipped(diag, "ar_aging_receivable_missing_required_field");
      continue;
    }
    const counterpartyKey = `ar_customer:${normalizeName(name) || name}`;
    out.push({
      kind: "counterparty",
      input: {
        sourceSystem: "document_upload",
        sourceNaturalKey: counterpartyKey,
        name,
        normalizedName: normalizeName(name) || null,
        type: "customer",
        email: null,
        extensions: { document_upload: { object_type: "ar_aging" } },
        common: sourceCommon,
      },
    });
    out.push({
      kind: "obligation",
      input: {
        sourceSystem: "document_upload",
        sourceNaturalKey: `ar:${invoiceRef}`,
        direction: "receivable",
        type: "invoice",
        counterpartySourceKey: counterpartyKey,
        amount,
        currency: currency(obj["currency"]),
        issueDate: null,
        dueDate: str(obj["due_date"]),
        status: str(obj["status"]) ?? "due",
        extensions: {
          document_upload: {
            object_type: "ar_aging",
            invoice_ref: invoiceRef,
            aging_bucket: str(obj["aging_bucket"]),
          },
        },
        common: sourceCommon,
      },
    });
  }
  return out;
}

function projectPayrollRegister(
  payload: Record<string, unknown>,
  common: ProjectionCommon,
  diag?: ConnectorProjectionDiagnostics,
): ConnectorLedgerProjection[] {
  const obligations = Array.isArray(payload["obligations"]) ? payload["obligations"] : [];
  const sourceCommon = commonWithParserConfidence(common);
  const out: ConnectorLedgerProjection[] = [];
  for (const raw of obligations) {
    const obj = asRecord(raw);
    const name = str(obj?.["counterparty_name"]) ?? "Payroll";
    const runRef = str(obj?.["run_ref"]);
    const amount = decimal(obj?.["amount"]);
    if (obj === null || runRef === null || amount === null) {
      skipped(diag, "payroll_register_obligation_missing_required_field");
      continue;
    }
    const counterpartyKey = `payroll:${normalizeName(name) || "payroll"}`;
    out.push({
      kind: "counterparty",
      input: {
        sourceSystem: "document_upload",
        sourceNaturalKey: counterpartyKey,
        name,
        normalizedName: normalizeName(name) || null,
        type: name === "Payroll" ? "other" : "employee",
        email: null,
        extensions: { document_upload: { object_type: "payroll_register" } },
        common: sourceCommon,
      },
    });
    out.push({
      kind: "obligation",
      input: {
        sourceSystem: "document_upload",
        sourceNaturalKey: `payroll:${runRef}`,
        direction: "payable",
        type: "payroll",
        counterpartySourceKey: counterpartyKey,
        amount,
        currency: currency(obj["currency"]),
        issueDate: null,
        dueDate: str(obj["due_date"]),
        status: str(obj["status"]) ?? "upcoming",
        extensions: {
          document_upload: {
            object_type: "payroll_register",
            run_ref: runRef,
            net_amount: decimal(obj["net_amount"]),
            tax_amount: decimal(obj["tax_amount"]),
            cadence: str(obj["cadence"]),
          },
        },
        common: sourceCommon,
      },
    });
  }
  return out;
}
