import { inflateRawSync, inflateSync } from "node:zlib";
import { brainError } from "@brain/shared";
import type { ArtifactInterpreter, InterpretedOutput } from "./registry.js";

export const UPLOAD_DOCUMENT_SCHEMA = "brain.upload.document.v1";
export const BANK_STATEMENT_UPLOAD_PARSER = "bank_statement_upload_v1";
export const DOCUMENT_RECORDS_UPLOAD_PARSER = "document_records_upload_v1";
const INTERPRETER_VERSION = "1.0.0";
const DEFAULT_CURRENCY = "USD";
const HEADER_SCAN_LIMIT = 10;
const AR_HEADER_KEYWORDS = [
  "ar",
  "accounts receivable",
  "receivable",
  "invoice",
  "inv",
  "aging",
  "customer",
  "client",
  "bucket",
  "open amount",
] as const;
const PAYROLL_HEADER_KEYWORDS = [
  "payroll",
  "pay run",
  "run id",
  "employee",
  "employee id",
  "employee name",
  "gross pay",
  "net pay",
  "net amount",
  "tax",
  "federal withholding",
  "state withholding",
  "withholding",
  "fica",
  "pay date",
  "cadence",
] as const;

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
  rawHeaders: string[];
  rows: string[][];
  headerIndex: number;
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
  if (looksLikeArAging(sheet)) return arAgingOutput(sheet);
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
    const streamBody = Buffer.from(trimPdfStreamBody(match[2] ?? ""), "latin1");
    let body: Buffer = streamBody;
    try {
      body = decodePdfStream(streamBody, pdfFilters(dict));
    } catch {
      body = streamBody;
    }
    const content = body.toString("latin1");
    chunks.push(...extractPdfTextOperations(content));
  }
  return chunks.length > 0 ? chunks.join("\n") : raw;
}

function trimPdfStreamBody(body: string): string {
  return body.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function pdfFilters(dict: string): string[] {
  const match = dict.match(/\/Filter\s*(\[[\s\S]*?\]|\/[A-Za-z0-9]+)/);
  if (match === null) return [];
  const value = match[1] ?? "";
  return [...value.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1] ?? "");
}

function decodePdfStream(streamBody: Buffer, filters: string[]): Buffer {
  let body = streamBody;
  for (const filter of filters) {
    if (filter === "ASCII85Decode" || filter === "A85") {
      body = ascii85Decode(body.toString("latin1"));
    } else if (filter === "FlateDecode" || filter === "Fl") {
      body = inflateSync(body);
    }
  }
  return body;
}

function ascii85Decode(input: string): Buffer {
  let encoded = input.trim();
  if (encoded.startsWith("<~")) encoded = encoded.slice(2);
  const end = encoded.indexOf("~>");
  if (end !== -1) encoded = encoded.slice(0, end);

  const bytes: number[] = [];
  let group = "";
  for (const ch of encoded) {
    if (/\s/.test(ch)) continue;
    if (ch === "z" && group.length === 0) {
      bytes.push(0, 0, 0, 0);
      continue;
    }
    if (ch < "!" || ch > "u") continue;
    group += ch;
    if (group.length === 5) {
      bytes.push(...ascii85Group(group, 4));
      group = "";
    }
  }
  if (group.length > 0) {
    const emitted = group.length - 1;
    bytes.push(...ascii85Group(group.padEnd(5, "u"), emitted));
  }
  return Buffer.from(bytes);
}

function ascii85Group(group: string, emitted: number): number[] {
  let value = 0;
  for (const ch of group) value = value * 85 + ch.charCodeAt(0) - 33;
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].slice(
    0,
    emitted,
  );
}

function extractPdfTextOperations(content: string): string[] {
  const out: string[] = [];
  const textOpRe =
    /(\[((?:\s*(?:\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>|-?\d+(?:\.\d+)?)\s*)+)\]\s*TJ\b)|((?:\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)\s*Tj\b)/g;
  for (const match of content.matchAll(textOpRe)) {
    const s =
      match[2] !== undefined
        ? extractPdfStringTokens(match[2]).join("").trim()
        : decodePdfStringToken((match[3] ?? "").replace(/\s*Tj\b$/, "")).trim();
    if (s.length > 0) out.push(s);
  }
  return out.filter((s) => s.length > 0);
}

function extractPdfStringTokens(content: string): string[] {
  const out: string[] = [];
  const tokenRe = /\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>/g;
  for (const match of content.matchAll(tokenRe)) {
    const decoded = decodePdfStringToken(match[0]).trim();
    if (decoded.length > 0) out.push(decoded);
  }
  return out;
}

function decodePdfStringToken(token: string): string {
  if (token.startsWith("(") && token.endsWith(")")) {
    return decodePdfLiteralString(token.slice(1, -1));
  }
  if (token.startsWith("<") && token.endsWith(">")) return decodePdfHexString(token.slice(1, -1));
  return token;
}

function decodePdfLiteralString(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) continue;
    if (/[0-7]/.test(next)) {
      let octal = next;
      let j = i + 2;
      while (j < value.length && octal.length < 3 && /[0-7]/.test(value[j]!)) {
        octal += value[j]!;
        j += 1;
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
      i = j - 1;
      continue;
    }
    out += decodePdfEscape(next);
    i += 1;
  }
  return out;
}

function decodePdfEscape(ch: string): string {
  if (ch === "n") return "\n";
  if (ch === "r") return "\r";
  if (ch === "t") return "\t";
  if (ch === "b") return "\b";
  if (ch === "f") return "\f";
  if (ch === "\n" || ch === "\r") return "";
  return ch;
}

function decodePdfHexString(value: string): string {
  const cleaned = value.replace(/\s+/g, "");
  if (!/^[0-9A-Fa-f]*$/.test(cleaned)) return "";
  const even = cleaned.length % 2 === 0 ? cleaned : `${cleaned}0`;
  return Buffer.from(even, "hex").toString("latin1");
}

function parseBankStatementText(text: string, ctx: UploadContext): BankStatementOutput {
  const tokens = text
    .split(/\r?\n/)
    .map((token) => token.replace(/\s+/g, " ").trim())
    .filter((token) => token.length > 0);
  const year = inferYear(tokens) ?? new Date().getUTCFullYear();
  const assembled = parseBankTransactionsFromTokens(tokens, year, ctx.rawArtifactId);
  const transactions =
    assembled.length > 0
      ? assembled
      : parseBankTransactionsFromLines(tokens, year, ctx.rawArtifactId);
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
      lines_seen: tokens.length,
      rows_parsed: transactions.length,
      rows_with_balance: rowsWithBalance,
    },
  };
}

function parseBankTransactionsFromLines(
  lines: string[],
  year: number,
  rawArtifactId: string,
): BankTransaction[] {
  const transactions: BankTransaction[] = [];
  for (const line of lines) {
    const parsed = parseBankTransactionLine(line, year, rawArtifactId, transactions.length);
    if (parsed !== null) transactions.push(parsed);
  }
  return transactions;
}

function parseBankTransactionsFromTokens(
  tokens: string[],
  fallbackYear: number,
  rawArtifactId: string,
): BankTransaction[] {
  const rows: Array<{ dateToken: string; cells: string[] }> = [];
  let current: { dateToken: string; cells: string[] } | null = null;
  for (const token of tokens) {
    if (isStandaloneFullDateToken(token)) {
      if (current !== null) rows.push(current);
      current = { dateToken: token, cells: [] };
      continue;
    }
    current?.cells.push(token);
  }
  if (current !== null) rows.push(current);
  if (rows.length === 0) return [];

  let previousBalance = inferOpeningBalance(tokens);
  const out: BankTransaction[] = [];
  for (const row of rows) {
    const parsed = parseBankTransactionTokenRow(
      row.dateToken,
      row.cells,
      fallbackYear,
      rawArtifactId,
      out.length,
      previousBalance,
    );
    if (parsed === null) continue;
    previousBalance = moneyToNumber(parsed.running_balance);
    out.push(parsed);
  }
  return out;
}

function parseBankTransactionTokenRow(
  dateToken: string,
  cells: string[],
  fallbackYear: number,
  rawArtifactId: string,
  index: number,
  previousBalance: number | null,
): BankTransaction | null {
  const date = normalizeDate(dateToken, fallbackYear);
  if (date === null) return null;

  const amountCells = cells
    .map((token, cellIndex) => ({ token, cellIndex, value: moneyToNumber(token) }))
    .filter(
      (cell): cell is { token: string; cellIndex: number; value: number } => cell.value !== null,
    );
  if (amountCells.length < 2) return null;

  const running = amountCells[amountCells.length - 1]!;
  const displayAmount =
    amountCells
      .slice(0, -1)
      .filter((cell) => cell.value !== 0)
      .at(-1) ?? amountCells[amountCells.length - 2]!;
  const description = cells.slice(0, displayAmount.cellIndex).join(" ").replace(/\s+/g, " ").trim();
  if (description.length === 0) return null;
  if (isBankStatementSummaryDescription(description)) return null;

  let direction = inferDirection(displayAmount.token, displayAmount.value, description);
  let amount = Math.abs(displayAmount.value);
  if (previousBalance !== null) {
    const delta = roundCents(running.value - previousBalance);
    if (delta !== 0) {
      direction = delta > 0 ? "inflow" : "outflow";
      amount = Math.abs(delta);
    }
  }

  return {
    transaction_id: `${rawArtifactId}:bank:${String(index + 1).padStart(4, "0")}`,
    date,
    description,
    amount: decimalString(amount),
    direction,
    currency: DEFAULT_CURRENCY,
    running_balance: decimalString(running.value),
    ...(counterpartyFromDescription(description) !== null
      ? { counterparty_name: counterpartyFromDescription(description)! }
      : {}),
  };
}

function isStandaloneFullDateToken(token: string): boolean {
  return /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/20\d{2}$/.test(token.trim());
}

function inferOpeningBalance(tokens: string[]): number | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (!/\b(opening|beginning|starting)\s+balance\b/.test(lower)) continue;
    const sameToken = [...token.matchAll(/(?:\(?-?\$?\d[\d,]*\.\d{2}\)?)/g)].at(-1)?.[0];
    const sameTokenValue = moneyToNumber(sameToken);
    if (sameTokenValue !== null) return sameTokenValue;
    for (const nextToken of tokens.slice(index + 1, index + 8)) {
      if (isStandaloneFullDateToken(nextToken)) break;
      const value = moneyToNumber(nextToken);
      if (value !== null) return value;
    }
  }
  return null;
}

function isBankStatementSummaryDescription(description: string): boolean {
  return /\bopening balance\b/i.test(description) && /\bclosing balance\b/i.test(description);
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
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
  const headerIndex = detectHeaderRow(rows);
  if (headerIndex === -1) {
    return { headers: [], rawHeaders: [], rows, headerIndex, records: [] };
  }
  const rawHeaders = rows[headerIndex]!.map((h) => h.trim());
  const headers = rawHeaders.map((h) => normalizeHeader(h));
  const records = rows
    .slice(headerIndex + 1)
    .map((row) => recordFromRow(headers, row))
    .filter((record) => Object.values(record).some((v) => v.length > 0));
  return { headers, rawHeaders, rows, headerIndex, records };
}

function detectHeaderRow(rows: string[][]): number {
  let fallback = -1;
  let best = { index: -1, score: -1 };
  for (let index = 0; index < Math.min(rows.length, HEADER_SCAN_LIMIT); index += 1) {
    const row = rows[index] ?? [];
    if (!row.some((cell) => cell.trim().length > 0)) continue;
    if (fallback === -1) fallback = index;
    const score = headerRowScore(row);
    if (score > best.score) best = { index, score };
  }
  return best.index === -1 ? fallback : best.index;
}

function headerRowScore(row: string[]): number {
  const normalized = row.map((cell) => normalizeHeader(cell)).filter((cell) => cell.length > 0);
  const distinct = new Set(normalized).size;
  const keywords = Math.max(
    keywordMatchCount(headerSearchText(row), AR_HEADER_KEYWORDS),
    keywordMatchCount(headerSearchText(row), PAYROLL_HEADER_KEYWORDS),
  );
  return keywords * 10 + distinct;
}

function keywordMatchCount(text: string, keywords: readonly string[]): number {
  return keywords.filter((keyword) => text.includes(` ${keyword} `)).length;
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
    .sort((a, b) => worksheetNumber(a) - worksheetNumber(b));
  if (sheetEntry.length === 0) return [];
  return sheetEntry.flatMap((entry) => {
    const sheetXml = files.get(entry)?.toString("utf8");
    return sheetXml === undefined ? [] : parseSheetRows(sheetXml, sharedStrings);
  });
}

function worksheetNumber(name: string): number {
  return Number(name.match(/sheet(\d+)\.xml$/)?.[1] ?? "0");
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
  const joined = headerSearchText(sheet.rawHeaders.length > 0 ? sheet.rawHeaders : sheet.headers);
  return keywordMatchCount(joined, AR_HEADER_KEYWORDS) > 0 && !looksLikePayroll(sheet);
}

function looksLikePayroll(sheet: ParsedSpreadsheet): boolean {
  const joined = headerSearchText(sheet.rawHeaders.length > 0 ? sheet.rawHeaders : sheet.headers);
  return keywordMatchCount(joined, PAYROLL_HEADER_KEYWORDS) > 0;
}

function arAgingOutput(sheet: ParsedSpreadsheet): InterpretedOutput {
  const receivables = [];
  for (const record of sheet.records) {
    const counterparty = firstField(record, ["counterparty", "customer", "client", "name"]);
    if (counterparty === null || /^total$/i.test(counterparty)) continue;
    const invoiceRef =
      firstField(record, [
        "invoice_ref",
        "invoice_no",
        "invoice",
        "invoice_number",
        "inv",
        "number",
      ]) ?? null;
    const explicitAmount = moneyToDecimal(
      firstField(record, [
        "total_due",
        "amount",
        "balance",
        "open_amount",
        "total",
        "total_amount",
      ]),
    );
    const bucketAmount = amountFromAgingBucketColumns(record);
    const amount = explicitAmount ?? bucketAmount?.amount;
    if (invoiceRef === null || amount === null || amount === "0" || amount === "0.00") continue;
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
  const aggregates = payrollAggregates(sheet, ctx);
  const obligations = [...aggregates.values()].map((aggregate) => ({
    counterparty_name: "Payroll",
    run_ref: aggregate.runRef,
    amount: decimalString(aggregate.netTotal !== 0 ? aggregate.netTotal : aggregate.grossTotal),
    net_amount: aggregate.netTotal === 0 ? null : decimalString(aggregate.netTotal),
    tax_amount: aggregate.taxTotal === 0 ? null : decimalString(aggregate.taxTotal),
    currency: aggregate.currency,
    due_date: aggregate.payDate,
    cadence: aggregate.cadence,
    status: aggregate.status,
  }));
  if (obligations.length === 0) {
    throw brainError("raw_source_unsupported", "payroll register upload contained no payroll rows");
  }
  return {
    parser: DOCUMENT_RECORDS_UPLOAD_PARSER,
    parserVersion: INTERPRETER_VERSION,
    extracted: { object_type: "payroll_register", obligations },
    confidence: spreadsheetConfidence(payrollParsedRowCount(aggregates), sheet.records.length),
  };
}

interface PayrollContext {
  runRef: string | null;
  payDate: string | null;
  cadence: string | null;
}

interface PayrollAggregate {
  runRef: string;
  payDate: string | null;
  cadence: string;
  status: string;
  currency: string;
  netTotal: number;
  taxTotal: number;
  grossTotal: number;
  rowCount: number;
}

function payrollAggregates(
  sheet: ParsedSpreadsheet,
  ctx: UploadContext,
): Map<string, PayrollAggregate> {
  const out = new Map<string, PayrollAggregate>();
  let currentContext: PayrollContext = { runRef: null, payDate: null, cadence: null };
  let currentHeaders: string[] | null = null;

  for (let index = 0; index < sheet.rows.length; index += 1) {
    const row = sheet.rows[index] ?? [];
    if (!row.some((cell) => cell.trim().length > 0)) continue;
    currentContext = mergePayrollContext(currentContext, payrollContextFromRow(row));
    if (looksLikePayrollHeaderRow(row)) {
      currentHeaders = row.map((cell) => normalizeHeader(cell));
      continue;
    }
    if (currentHeaders === null) continue;
    if (looksLikePreambleRow(row)) continue;

    const record = recordFromRow(currentHeaders, row);
    if (applyPayrollSummaryRow(out, currentContext, record, row)) continue;
    if (!isPayrollEmployeeRow(record)) continue;
    const netAmount = moneyToNumber(firstField(record, ["net_pay", "net", "net_amount"]));
    const taxAmount = sumMoneyFields(record, [
      "tax",
      "taxes",
      "tax_amount",
      "withholding",
      "federal_withholding",
      "state_withholding",
      "fica",
      "fica_tax",
      "fica_social_security",
      "fica_medicare",
      "medicare",
      "social_security",
      "employer_tax",
    ]);
    const grossAmount = moneyToNumber(firstField(record, ["gross", "gross_pay", "total"]));
    const amount = netAmount ?? grossAmount;
    if (amount === null) continue;

    const runRef =
      firstField(record, ["run_ref", "pay_run", "payroll_run", "payroll_id", "run_id"]) ??
      currentContext.runRef ??
      `${ctx.rawArtifactId}:payroll:${out.size + 1}`;
    const payDate =
      normalizeSpreadsheetDate(
        firstField(record, ["pay_date", "payment_date", "run_date", "due_date"]),
      ) ?? currentContext.payDate;
    const cadence =
      firstField(record, ["cadence", "frequency", "run_cadence"]) ??
      currentContext.cadence ??
      "unknown";
    const status = firstField(record, ["status"]) ?? "upcoming";
    const currency = currencyField(record);
    const key = `${runRef}|${payDate ?? ""}`;
    const aggregate =
      out.get(key) ??
      ({
        runRef,
        payDate,
        cadence,
        status,
        currency,
        netTotal: 0,
        taxTotal: 0,
        grossTotal: 0,
        rowCount: 0,
      } satisfies PayrollAggregate);
    aggregate.netTotal += netAmount ?? 0;
    aggregate.taxTotal += taxAmount;
    aggregate.grossTotal += grossAmount ?? 0;
    aggregate.rowCount += 1;
    out.set(key, aggregate);
  }
  return out;
}

function looksLikePayrollHeaderRow(row: string[]): boolean {
  const text = headerSearchText(row);
  return (
    (text.includes(" net pay ") || text.includes(" gross pay ")) &&
    (text.includes(" employee ") ||
      text.includes(" employee id ") ||
      text.includes(" payroll run ") ||
      text.includes(" pay run ") ||
      text.includes(" tax ") ||
      text.includes(" withholding ") ||
      text.includes(" fica ") ||
      text.includes(" w h "))
  );
}

function looksLikePreambleRow(row: string[]): boolean {
  const nonEmpty = row.filter((cell) => cell.trim().length > 0).length;
  if (nonEmpty === 0) return true;
  return nonEmpty <= 4 && payrollContextFromRow(row).runRef !== null;
}

function payrollContextFromRow(row: string[]): PayrollContext {
  const context: PayrollContext = { runRef: null, payDate: null, cadence: null };
  const joined = row
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
    .join(" | ");
  const runMatch = joined.match(/\bpay\s+run\s*:\s*([^|,;]+)/i);
  if (runMatch !== null) context.runRef = runMatch[1]!.trim();
  const dateMatch = joined.match(/\bpay\s+date\s*:\s*([^|,;]+)/i);
  if (dateMatch !== null) context.payDate = normalizeSpreadsheetDate(dateMatch[1]!.trim());
  const cadenceMatch = joined.match(/\bcadence\s*:\s*([^|,;]+)/i);
  if (cadenceMatch !== null) context.cadence = cadenceMatch[1]!.trim();

  for (let index = 0; index < row.length; index += 1) {
    const raw = row[index]?.trim() ?? "";
    if (raw.length === 0) continue;
    const normalized = normalizeHeader(raw);
    const next = row[index + 1]?.trim() ?? "";
    const labelValue = raw.match(/^\s*([^:]+):\s*(.+?)\s*$/);
    const label = normalizeHeader(labelValue?.[1] ?? raw);
    const value = firstPreambleValue(labelValue?.[2]?.trim() ?? next);
    if (
      context.runRef === null &&
      /^(pay_run|pay_run_id|payroll_run|payroll_id|run_id)$/.test(normalized) &&
      next
    ) {
      context.runRef = firstPreambleValue(next);
    } else if (
      context.runRef === null &&
      /^(pay_run|pay_run_id|payroll_run|payroll_id|run_id)$/.test(label) &&
      value
    ) {
      context.runRef = value;
    } else if (/^(pay_date|payment_date|run_date)$/.test(normalized) && next) {
      context.payDate = normalizeSpreadsheetDate(next);
    } else if (/^(pay_date|payment_date|run_date)$/.test(label) && value) {
      context.payDate = normalizeSpreadsheetDate(value);
    } else if (/^(cadence|frequency|run_cadence)$/.test(normalized) && next) {
      context.cadence = next;
    } else if (/^(cadence|frequency|run_cadence)$/.test(label) && value) {
      context.cadence = value;
    }
  }
  return context;
}

function firstPreambleValue(value: string): string {
  return value.split(/[|,;]/, 1)[0]!.trim();
}

function mergePayrollContext(base: PayrollContext, next: PayrollContext): PayrollContext {
  return {
    runRef: next.runRef ?? base.runRef,
    payDate: next.payDate ?? base.payDate,
    cadence: next.cadence ?? base.cadence,
  };
}

function sumMoneyFields(record: SpreadsheetRecord, names: string[]): number {
  let total = 0;
  const matched = new Set<string>();
  for (const name of names) {
    const field = normalizeHeader(name);
    const value = moneyToNumber(record[field]);
    matched.add(field);
    if (value !== null) total += value;
  }
  for (const [field, raw] of Object.entries(record)) {
    if (matched.has(field) || !looksLikePayrollTaxField(field)) continue;
    const value = moneyToNumber(raw);
    if (value !== null) total += value;
  }
  return total;
}

function isPayrollEmployeeRow(record: SpreadsheetRecord): boolean {
  return (
    firstField(record, ["emp_id", "employee_id", "employee", "employee_name"]) !== null ||
    firstField(record, ["run_ref", "pay_run", "payroll_run", "payroll_id", "run_id"]) !== null
  );
}

function applyPayrollSummaryRow(
  aggregates: Map<string, PayrollAggregate>,
  context: PayrollContext,
  record: SpreadsheetRecord,
  row: string[],
): boolean {
  const rowText = headerSearchText(row);
  const runRef = context.runRef;
  if (runRef === null) return false;
  const payDate = context.payDate;
  const key = `${runRef}|${payDate ?? ""}`;
  const aggregate = aggregates.get(key);
  if (aggregate === undefined) return false;
  const value = firstMoneyValue(row);
  if (value === null) return /\b(total|summary|remittance|ach debit)\b/.test(rowText);
  if (rowText.includes(" total tax remittance ")) {
    aggregate.taxTotal = value;
    return true;
  }
  if (rowText.includes(" net pay ach debit ")) {
    aggregate.netTotal = value;
    return true;
  }
  if (firstField(record, ["emp_id", "employee_id", "employee", "employee_name"]) === null) {
    return /\b(total|summary|remittance|ach debit|employer)\b/.test(rowText);
  }
  return false;
}

function firstMoneyValue(row: string[]): number | null {
  for (const cell of row) {
    const value = moneyToNumber(cell);
    if (value !== null) return value;
  }
  return null;
}

function looksLikePayrollTaxField(field: string): boolean {
  const text = ` ${field.replace(/_/g, " ")} `;
  if (text.includes(" net ") || text.includes(" gross ") || text.includes(" pay date ")) {
    return false;
  }
  return (
    text.includes(" withholding ") ||
    text.includes(" w h ") ||
    text.includes(" fica ") ||
    text.includes(" medicare ") ||
    text.includes(" social security ") ||
    /\b(fed|federal|state|local)\s+w\s+h\b/.test(text)
  );
}

function payrollParsedRowCount(aggregates: Map<string, PayrollAggregate>): number {
  return [...aggregates.values()].reduce((sum, aggregate) => sum + aggregate.rowCount, 0);
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

function headerSearchText(values: string[]): string {
  return ` ${values
    .map((value) => value.trim().toLowerCase().replace(/_/g, " "))
    .join(" ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
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

function normalizeSpreadsheetDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;
  const year = raw.match(/\b(20\d{2})\b/)?.[1];
  return normalizeDate(raw, year === undefined ? new Date().getUTCFullYear() : Number(year));
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

function moneyToNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
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
