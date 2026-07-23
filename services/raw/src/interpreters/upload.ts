import { inflateRawSync, inflateSync } from "node:zlib";
import { brainError } from "@brain/shared";
import type { ArtifactInterpreter, InterpretedOutput } from "./registry.js";

export const UPLOAD_DOCUMENT_SCHEMA = "brain.upload.document.v1";
export const BANK_STATEMENT_UPLOAD_PARSER = "bank_statement_upload_v1";
export const DOCUMENT_RECORDS_UPLOAD_PARSER = "document_records_upload_v1";
const INTERPRETER_VERSION = "1.0.0";
const DEFAULT_CURRENCY = "USD";

export function defaultSourceSchemaForUpload(sourceType: string): string | null {
  if (sourceType === "pdf_upload" || sourceType === "csv_upload") return UPLOAD_DOCUMENT_SCHEMA;
  return null;
}

interface UploadContext {
  rawArtifactId: string;
  sourceType: string;
  sourceRef: Record<string, unknown>;
  mimeType?: string | null;
}

interface BankTransaction {
  transaction_id: string;
  date: string;
  description: string;
  amount: string;
  direction: "inflow" | "outflow";
  currency: string;
  running_balance?: string;
  counterparty_name?: string;
}

interface BankStatementOutput extends Record<string, unknown> {
  object_type: "bank_statement";
  account: {
    account_id: string;
    institution: string | null;
    name: string;
    currency: string;
    current_balance: string | null;
  };
  transactions: BankTransaction[];
  parse_diagnostics: {
    lines_seen: number;
    rows_parsed: number;
    rows_with_balance: number;
  };
}

interface SpreadsheetRecord {
  [key: string]: string;
}

interface ParsedSpreadsheet {
  headers: string[];
  records: SpreadsheetRecord[];
}

export const uploadDocumentInterpreter: ArtifactInterpreter = (bytes, ctx) => {
  const uploadCtx: UploadContext = {
    rawArtifactId: ctx.rawArtifactId,
    sourceType: ctx.sourceType,
    sourceRef: ctx.sourceRef,
    mimeType: ctx.mimeType,
  };
  if (ctx.sourceType === "pdf_upload") {
    return interpretBankStatementPdf(bytes, uploadCtx);
  }
  if (ctx.sourceType === "csv_upload") {
    return interpretSpreadsheetUpload(bytes, uploadCtx);
  }
  throw brainError(
    "raw_source_unsupported",
    `upload interpreter does not support ${ctx.sourceType}`,
  );
};

function interpretBankStatementPdf(bytes: Buffer, ctx: UploadContext): InterpretedOutput | null {
  const text = extractPdfText(bytes);
  const parsed = parseBankStatementText(text, ctx);
  if (parsed.transactions.length === 0) {
    throw brainError(
      "raw_source_unsupported",
      "bank statement upload contained no transaction rows",
    );
  }
  return {
    parser: BANK_STATEMENT_UPLOAD_PARSER,
    parserVersion: INTERPRETER_VERSION,
    extracted: parsed,
    confidence: bankStatementConfidence(parsed),
  };
}

function interpretSpreadsheetUpload(bytes: Buffer, ctx: UploadContext): InterpretedOutput | null {
  const sheet = parseSpreadsheet(bytes, ctx);
  if (sheet.records.length === 0) {
    throw brainError(
      "raw_source_unsupported",
      "spreadsheet upload contained no parseable data rows",
      { statusOverride: 422, details: { headers: sheet.headers } },
    );
  }
  if (looksLikePayroll(sheet)) return payrollOutput(sheet, ctx);
  if (looksLikeArAging(sheet)) return arAgingOutput(sheet, ctx);
  throw brainError(
    "raw_source_unsupported",
    "spreadsheet upload did not match AR aging or payroll register headers",
    { statusOverride: 422, details: { headers: sheet.headers } },
  );
}

function extractPdfText(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  if (!raw.startsWith("%PDF-")) return bytes.toString("utf8");

  const chunks: string[] = [];
  const streamRe = /<<([\s\S]*?)>>\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  for (const match of raw.matchAll(streamRe)) {
    const dict = match[1] ?? "";
    const streamBody = Buffer.from(match[2] ?? "", "latin1");
    let body: Buffer;
    try {
      body = /\/FlateDecode\b/.test(dict) ? inflateSync(streamBody) : streamBody;
    } catch {
      body = streamBody;
    }
    const content = body.toString("latin1");
    chunks.push(...extractPdfStringLiterals(content));
  }
  return chunks.length > 0 ? chunks.join("\n") : raw;
}

function extractPdfStringLiterals(content: string): string[] {
  const out: string[] = [];
  let current = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    if (!inString) {
      if (ch === "(") {
        inString = true;
        current = "";
      }
      continue;
    }
    if (escaped) {
      current += decodePdfEscape(ch);
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === ")") {
      const s = current.trim();
      if (s.length > 0) out.push(s);
      inString = false;
      continue;
    }
    current += ch;
  }
  return out;
}

function decodePdfEscape(ch: string): string {
  if (ch === "n") return "\n";
  if (ch === "r") return "\r";
  if (ch === "t") return "\t";
  if (ch === "b") return "\b";
  if (ch === "f") return "\f";
  return ch;
}

function parseBankStatementText(text: string, ctx: UploadContext): BankStatementOutput {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  const year = inferYear(lines) ?? new Date().getUTCFullYear();
  const transactions: BankTransaction[] = [];
  for (const line of lines) {
    const parsed = parseBankTransactionLine(line, year, ctx.rawArtifactId, transactions.length);
    if (parsed !== null) transactions.push(parsed);
  }
  const rowsWithBalance = transactions.filter((tx) => tx.running_balance !== undefined).length;
  const currentBalance = [...transactions]
    .reverse()
    .find((tx) => tx.running_balance !== undefined)?.running_balance;
  return {
    object_type: "bank_statement",
    account: {
      account_id: stringRef(ctx.sourceRef, "account_id") ?? `upload:${ctx.rawArtifactId}:account`,
      institution: stringRef(ctx.sourceRef, "institution") ?? stringRef(ctx.sourceRef, "bank_name"),
      name: stringRef(ctx.sourceRef, "account_name") ?? "Uploaded bank statement",
      currency: currencyFromRef(ctx.sourceRef),
      current_balance: currentBalance ?? null,
    },
    transactions,
    parse_diagnostics: {
      lines_seen: lines.length,
      rows_parsed: transactions.length,
      rows_with_balance: rowsWithBalance,
    },
  };
}

function parseBankTransactionLine(
  line: string,
  fallbackYear: number,
  rawArtifactId: string,
  index: number,
): BankTransaction | null {
  const dateMatch = line.match(
    /^((?:20\d{2}[-/]\d{1,2}[-/]\d{1,2})|(?:\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?)|(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}))(?:\s+|$)/i,
  );
  if (dateMatch === null) return null;
  const date = normalizeDate(dateMatch[1]!, fallbackYear);
  if (date === null) return null;

  const rest = line.slice(dateMatch[0].length).trim();
  const amountMatches = [...rest.matchAll(/(?:\(?-?\$?\d[\d,]*\.\d{2}\)?)/g)];
  if (amountMatches.length === 0) return null;
  const amounts = amountMatches.map((m) => ({
    token: m[0],
    index: m.index ?? 0,
    value: moneyToNumber(m[0]),
  }));
  const validAmounts = amounts.filter((a) => a.value !== null) as Array<{
    token: string;
    index: number;
    value: number;
  }>;
  if (validAmounts.length === 0) return null;

  const firstAmountIndex = validAmounts[0]!.index;
  const description = rest.slice(0, firstAmountIndex).replace(/\s+/g, " ").trim();
  if (description.length === 0) return null;

  const runningBalance =
    validAmounts.length >= 2 ? decimalString(validAmounts[validAmounts.length - 1]!.value) : null;
  const candidates = runningBalance === null ? validAmounts : validAmounts.slice(0, -1);
  const amountCandidate = pickAmountCandidate(candidates, description);
  if (amountCandidate === null || amountCandidate.value === 0) return null;

  const direction = inferDirection(amountCandidate.token, amountCandidate.value, description);
  return {
    transaction_id: `${rawArtifactId}:bank:${String(index + 1).padStart(4, "0")}`,
    date,
    description,
    amount: decimalString(Math.abs(amountCandidate.value)),
    direction,
    currency: DEFAULT_CURRENCY,
    ...(runningBalance !== null ? { running_balance: runningBalance } : {}),
    ...(counterpartyFromDescription(description) !== null
      ? { counterparty_name: counterpartyFromDescription(description)! }
      : {}),
  };
}

function pickAmountCandidate(
  candidates: Array<{ token: string; value: number }>,
  description: string,
): { token: string; value: number } | null {
  const nonZero = candidates.filter((a) => a.value !== 0);
  if (nonZero.length === 0) return null;
  if (nonZero.length === 1) return nonZero[0]!;
  const lower = description.toLowerCase();
  if (/\b(credit|deposit|interest|refund|received|payment received|ach credit)\b/.test(lower)) {
    return nonZero[nonZero.length - 1]!;
  }
  return nonZero[0]!;
}

function inferDirection(token: string, value: number, description: string): "inflow" | "outflow" {
  const lower = description.toLowerCase();
  if (token.includes("-") || token.includes("(")) return "outflow";
  if (value < 0) return "outflow";
  if (/\b(credit|deposit|interest|refund|received|payment received|ach credit)\b/.test(lower)) {
    return "inflow";
  }
  return "outflow";
}

function counterpartyFromDescription(description: string): string | null {
  const cleaned = description
    .replace(/\b(ach|pos|debit|credit|card|online|payment|deposit|withdrawal)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function bankStatementConfidence(parsed: BankStatementOutput): number {
  const rows = parsed.transactions.length;
  const withBalance = parsed.parse_diagnostics.rows_with_balance;
  if (rows >= 10 && withBalance / rows >= 0.8) return 0.9;
  if (rows >= 5 && withBalance / rows >= 0.5) return 0.78;
  if (rows >= 3) return 0.62;
  return 0.42;
}

function parseSpreadsheet(bytes: Buffer, ctx: UploadContext): ParsedSpreadsheet {
  const rows = isXlsx(bytes, ctx)
    ? rowsFromXlsx(bytes)
    : parseCsv(bytes.toString("utf8")).map((row) => row.map((cell) => cell.trim()));
  const headerIndex = rows.findIndex((row) => row.some((cell) => cell.trim().length > 0));
  if (headerIndex === -1) return { headers: [], records: [] };
  const headers = rows[headerIndex]!.map((h) => normalizeHeader(h));
  const records = rows
    .slice(headerIndex + 1)
    .map((row) => recordFromRow(headers, row))
    .filter((record) => Object.values(record).some((v) => v.length > 0));
  return { headers, records };
}

function isXlsx(bytes: Buffer, ctx: UploadContext): boolean {
  const mime = ctx.mimeType?.toLowerCase() ?? "";
  return (
    bytes.subarray(0, 2).toString("utf8") === "PK" ||
    mime.includes("spreadsheet") ||
    mime.includes("excel")
  );
}

function rowsFromXlsx(bytes: Buffer): string[][] {
  const files = unzipXlsx(bytes);
  const sharedStrings = parseSharedStrings(
    files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "",
  );
  const sheetEntry = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];
  if (sheetEntry === undefined) return [];
  const sheetXml = files.get(sheetEntry)?.toString("utf8");
  return sheetXml === undefined ? [] : parseSheetRows(sheetXml, sharedStrings);
}

function unzipXlsx(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset === -1) return files;
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  let cursor = centralDirectoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const fileNameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const fileName = bytes.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    const data = localZipFileData(bytes, localHeaderOffset, compressedSize, method);
    if (data !== null) files.set(fileName, data);
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return files;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function localZipFileData(
  bytes: Buffer,
  localHeaderOffset: number,
  compressedSize: number,
  method: number,
): Buffer | null {
  if (bytes.readUInt32LE(localHeaderOffset) !== 0x04034b50) return null;
  const fileNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
  const extraLength = bytes.readUInt16LE(localHeaderOffset + 28);
  const start = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = bytes.subarray(start, start + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) {
    try {
      return inflateRawSync(compressed);
    } catch {
      return null;
    }
  }
  return null;
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) => textFromXmlCell(match[0]));
}

function parseSheetRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
    const row: string[] = [];
    for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const cellRef = attribute(attrs, "r");
      const index = cellRef === null ? row.length : columnIndex(cellRef);
      row[index] = xlsxCellValue(attrs, body, sharedStrings);
    }
    if (row.some((cell) => (cell ?? "").trim().length > 0)) {
      rows.push(row.map((cell) => cell ?? ""));
    }
  }
  return rows;
}

function xlsxCellValue(attrs: string, body: string, sharedStrings: string[]): string {
  const type = attribute(attrs, "t");
  if (type === "inlineStr") return textFromXmlCell(body);
  const value = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
  if (type === "s") return sharedStrings[Number(value)] ?? "";
  if (type === "str") return xmlUnescape(value);
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return xmlUnescape(value);
}

function textFromXmlCell(xml: string): string {
  return [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
    .map((match) => xmlUnescape(match[1] ?? ""))
    .join("");
}

function attribute(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match === null ? null : xmlUnescape(match[1] ?? "");
}

function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0] ?? "";
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + letter.charCodeAt(0) - 64;
  }
  return Math.max(index - 1, 0);
}

function xmlUnescape(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (entity, code: string) => {
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "amp") return "&";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    if (code.toLowerCase().startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return entity;
  });
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function recordFromRow(headers: string[], row: string[]): SpreadsheetRecord {
  const record: SpreadsheetRecord = {};
  headers.forEach((header, index) => {
    if (header.length === 0) return;
    record[header] = row[index]?.trim() ?? "";
  });
  return record;
}

function looksLikeArAging(sheet: ParsedSpreadsheet): boolean {
  const joined = sheet.headers.join(" ");
  return (
    /\b(invoice|inv|receivable|ar|aging|customer|client)\b/.test(joined) && !looksLikePayroll(sheet)
  );
}

function looksLikePayroll(sheet: ParsedSpreadsheet): boolean {
  const joined = sheet.headers.join(" ");
  return /\b(payroll|net_pay|net|tax|withholding|pay_date|cadence|pay_run)\b/.test(joined);
}

function arAgingOutput(sheet: ParsedSpreadsheet, ctx: UploadContext): InterpretedOutput {
  const receivables = [];
  for (const [index, record] of sheet.records.entries()) {
    const counterparty = firstField(record, ["counterparty", "customer", "client", "name"]);
    const invoiceRef =
      firstField(record, ["invoice_ref", "invoice", "invoice_number", "inv", "number"]) ??
      `${ctx.rawArtifactId}:ar:${index + 1}`;
    const explicitAmount = moneyToDecimal(
      firstField(record, ["amount", "balance", "open_amount", "total", "total_amount"]),
    );
    const bucketAmount = amountFromAgingBucketColumns(record);
    const amount = explicitAmount ?? bucketAmount?.amount;
    if (counterparty === null || amount === null) continue;
    receivables.push({
      counterparty_name: counterparty,
      invoice_ref: invoiceRef,
      amount,
      currency: currencyField(record),
      aging_bucket:
        firstField(record, ["aging_bucket", "bucket", "age_bucket"]) ??
        bucketAmount?.bucket ??
        null,
      due_date: firstField(record, ["due_date", "due", "invoice_due_date"]),
      status: firstField(record, ["status"]) ?? "due",
    });
  }
  if (receivables.length === 0) {
    throw brainError("raw_source_unsupported", "AR aging upload contained no receivable rows");
  }
  return {
    parser: DOCUMENT_RECORDS_UPLOAD_PARSER,
    parserVersion: INTERPRETER_VERSION,
    extracted: { object_type: "ar_aging", receivables },
    confidence: spreadsheetConfidence(receivables.length, sheet.records.length),
  };
}

function payrollOutput(sheet: ParsedSpreadsheet, ctx: UploadContext): InterpretedOutput {
  const obligations = [];
  for (const [index, record] of sheet.records.entries()) {
    const netAmount = moneyToDecimal(firstField(record, ["net_pay", "net", "net_amount"]));
    const taxAmount = moneyToDecimal(
      firstField(record, ["tax", "taxes", "tax_amount", "withholding", "employer_tax"]),
    );
    const grossAmount = moneyToDecimal(firstField(record, ["gross", "gross_pay", "total"]));
    const amount = addDecimals(netAmount, taxAmount) ?? grossAmount;
    if (amount === null) continue;
    obligations.push({
      counterparty_name: firstField(record, ["counterparty", "payee", "processor"]) ?? "Payroll",
      run_ref:
        firstField(record, ["run_ref", "pay_run", "payroll_run", "payroll_id"]) ??
        `${ctx.rawArtifactId}:payroll:${index + 1}`,
      amount,
      net_amount: netAmount,
      tax_amount: taxAmount,
      currency: currencyField(record),
      due_date: firstField(record, ["pay_date", "payment_date", "run_date", "due_date"]),
      cadence: firstField(record, ["cadence", "frequency", "run_cadence"]) ?? "unknown",
      status: firstField(record, ["status"]) ?? "upcoming",
    });
  }
  if (obligations.length === 0) {
    throw brainError("raw_source_unsupported", "payroll register upload contained no payroll rows");
  }
  return {
    parser: DOCUMENT_RECORDS_UPLOAD_PARSER,
    parserVersion: INTERPRETER_VERSION,
    extracted: { object_type: "payroll_register", obligations },
    confidence: spreadsheetConfidence(obligations.length, sheet.records.length),
  };
}

function spreadsheetConfidence(parsedRows: number, totalRows: number): number {
  if (parsedRows === 0) return 0.1;
  const ratio = parsedRows / Math.max(totalRows, 1);
  if (ratio >= 0.9) return 0.9;
  if (ratio >= 0.6) return 0.72;
  return 0.48;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[#/]+/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function firstField(record: SpreadsheetRecord, names: string[]): string | null {
  for (const name of names) {
    const normalized = normalizeHeader(name);
    const v = record[normalized];
    if (v !== undefined && v.trim().length > 0) return v.trim();
  }
  return null;
}

function amountFromAgingBucketColumns(
  record: SpreadsheetRecord,
): { bucket: string; amount: string } | null {
  const buckets = [
    ["current", "current"],
    ["1_30", "1-30"],
    ["0_30", "0-30"],
    ["31_60", "31-60"],
    ["61_90", "61-90"],
    ["90", "90+"],
    ["90_plus", "90+"],
    ["over_90", "90+"],
  ] as const;
  for (const [field, bucket] of buckets) {
    const amount = moneyToDecimal(record[field]);
    if (amount !== null && amount !== "0" && amount !== "0.00") return { bucket, amount };
  }
  return null;
}

function currencyField(record: SpreadsheetRecord): string {
  const c = firstField(record, ["currency"]);
  if (c !== null && /^[A-Za-z]{3}$/.test(c)) return c.toUpperCase();
  return DEFAULT_CURRENCY;
}

function currencyFromRef(sourceRef: Record<string, unknown>): string {
  const c = stringRef(sourceRef, "currency");
  if (c !== null && /^[A-Za-z]{3}$/.test(c)) return c.toUpperCase();
  return DEFAULT_CURRENCY;
}

function stringRef(ref: Record<string, unknown>, key: string): string | null {
  const v = ref[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function inferYear(lines: string[]): number | null {
  for (const line of lines) {
    const match = line.match(/\b(20\d{2})\b/);
    if (match !== null) return Number(match[1]);
  }
  return null;
}

function normalizeDate(raw: string, fallbackYear: number): string | null {
  const trimmed = raw.trim().replace(",", "");
  const iso = trimmed.match(/^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso !== null) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slash = trimmed.match(/^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?$/);
  if (slash !== null) {
    const year =
      slash[3] === undefined
        ? fallbackYear
        : slash[3].length === 2
          ? 2000 + Number(slash[3])
          : Number(slash[3]);
    return ymd(year, Number(slash[1]), Number(slash[2]));
  }
  const named = trimmed.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/);
  if (named !== null) {
    const month = monthNumber(named[1]!);
    if (month === null) return null;
    return ymd(fallbackYear, month, Number(named[2]));
  }
  return null;
}

function ymd(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthNumber(raw: string): number | null {
  const key = raw.slice(0, 3).toLowerCase();
  const months: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  return months[key] ?? null;
}

function moneyToNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const negative = trimmed.includes("(") || trimmed.includes("-");
  const cleaned = trimmed.replace(/[$,()\s-]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function moneyToDecimal(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const n = moneyToNumber(raw);
  if (n === null || n < 0) return null;
  return decimalString(n);
}

function decimalString(value: number): string {
  return value.toFixed(2).replace(/\.00$/, "");
}

function addDecimals(a: string | null, b: string | null): string | null {
  if (a === null && b === null) return null;
  const sum = Number(a ?? "0") + Number(b ?? "0");
  return Number.isFinite(sum) ? decimalString(sum) : null;
}
