#!/usr/bin/env node
/**
 * Materialize the core-owned fixture bundle used by the staging document
 * ingestion smoke. These fixtures intentionally live outside demo_seed: the
 * smoke proves raw ingestion without changing ordinary demo provisioning.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_ROOT = join(ROOT, "services/raw/src/interpreters/__fixtures__");

export const STAGING_DOCUMENT_SMOKE_FIXTURES = Object.freeze([
  {
    filename: "form_1120_2025.pdf",
    sourceType: "pdf_upload",
    mimeType: "application/pdf",
    write: writeTaxReturnPdf,
  },
  {
    filename: "crypto_wallet_2026-08-04.csv",
    sourceType: "csv_upload",
    mimeType: "text/csv",
    write: writeCryptoWalletCsv,
  },
  {
    filename: "payroll_register_2026-08-04.xlsx",
    sourceType: "csv_upload",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    source: join(FIXTURE_ROOT, "payroll_register_2026-06.xlsx"),
  },
  {
    filename: "ar_aging_2026-08-04.xlsx",
    sourceType: "csv_upload",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    source: join(FIXTURE_ROOT, "ar_aging_2026-06-30.xlsx"),
  },
]);

/**
 * Builds the four source-equivalent fixture files needed by the staging-only
 * smoke. The xlsx files reuse the parser fixtures, while tax and wallet files
 * exercise the external document extraction fallback.
 */
export function writeStagingDocumentSmokeFixtures(outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const fixtures = STAGING_DOCUMENT_SMOKE_FIXTURES.map((fixture) => {
    const outputPath = join(outputDir, fixture.filename);
    if (fixture.source !== undefined) copyFileSync(fixture.source, outputPath);
    else fixture.write(outputPath);
    return {
      filename: fixture.filename,
      source_type: fixture.sourceType,
      mime_type: fixture.mimeType,
      path: outputPath,
    };
  });
  return fixtures;
}

function writeTaxReturnPdf(outputPath) {
  writeFileSync(
    outputPath,
    makePdf([
      "Form 1120 U.S. Corporation Income Tax Return",
      "Brightline Systems Inc.",
      "Federal income tax remittance",
      "Amount due: $2,500.00",
      "Due date: 2026-08-15",
      "Status: upcoming",
    ]),
  );
}

function writeCryptoWalletCsv(outputPath) {
  writeFileSync(
    outputPath,
    [
      "wallet,asset,transaction_type,amount_usd,counterparty,due_date,status",
      "Brightline Treasury Wallet,USDC,settlement,2500.00,Harbor Reserve,2026-08-15,upcoming",
    ].join("\n") + "\n",
  );
}

function makePdf(lines) {
  const escapedLines = lines.map((line) => `(${escapePdfText(line)}) Tj`).join(" T*\n");
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n${escapedLines}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
  ];

  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(document, "latin1"));
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, "latin1");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

function escapePdfText(value) {
  return value.replace(/([\\()])/g, "\\$1");
}

function outputDirectoryFromArgs(args) {
  if (args.length !== 2 || args[0] !== "--output-dir" || args[1].length === 0) {
    throw new Error("usage: write-staging-document-smoke-fixtures.mjs --output-dir <path>");
  }
  return args[1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixtures = writeStagingDocumentSmokeFixtures(
    outputDirectoryFromArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify({ fixtures })}\n`);
}
