import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  interpreterForSchema,
  registeredSchemas,
  registerInterpreter,
  type InterpreterArtifactContext,
} from "./registry.js";
import { UPLOAD_DOCUMENT_SCHEMA, uploadDocumentInterpreter } from "./upload.js";

function ctx(over: Partial<InterpreterArtifactContext> = {}): InterpreterArtifactContext {
  return {
    rawArtifactId: "raw_1",
    tenantId: "tnt_1",
    sourceType: "stripe",
    sourceSchema: "stripe.balance_transactions.v1",
    sourceRef: { stripe_account_id: "acct_stripe1" },
    sourceId: "src_1",
    objectType: "balance_transaction",
    mimeType: null,
    ...over,
  };
}

function makeXlsxRows(rows: string[][], options: { deflate?: boolean } = {}): Buffer {
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, colIndex) => {
          const ref = `${columnName(colIndex)}${rowIndex + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return makeXlsxWithSheet(sheetRows, options);
}

function makeXlsxWithSheet(
  sheetRows: string,
  options: { deflate?: boolean; sharedStrings?: string } = {},
): Buffer {
  return makeZip(
    {
      "[Content_Types].xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="xml" ContentType="application/xml"/>',
        "</Types>",
      ].join(""),
      "xl/workbook.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>',
        "</workbook>",
      ].join(""),
      ...(options.sharedStrings !== undefined
        ? { "xl/sharedStrings.xml": options.sharedStrings }
        : {}),
      "xl/worksheets/sheet1.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        `<sheetData>${sheetRows}</sheetData>`,
        "</worksheet>",
      ].join(""),
    },
    options.deflate === undefined ? {} : { deflate: options.deflate },
  );
}

function makeZip(
  files: Record<string, string>,
  options: { deflate?: boolean; method?: number } = {},
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const method = options.method ?? (options.deflate === true ? 8 : 0);
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function makeMinimalPdf(lines: string[]): Buffer {
  const text = lines.map((line) => `(${line.replace(/([\\()])/g, "\\$1")}) Tj`).join("\n");
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<<>>\nstream\n${text}\nendstream\nendobj\n`, "latin1");
}

function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    n = Math.floor((n - mod) / 26);
  }
  return out;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fixtureBytes(name: string): Buffer {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
}

describe("interpreter registry", () => {
  it("registers the built-in plaid and stripe page schemas", () => {
    expect(registeredSchemas()).toEqual(
      expect.arrayContaining([
        "plaid.transactions_sync.v1",
        "stripe.balance_transactions.v1",
        "stripe.charges.v1",
        "stripe.payouts.v1",
        "stripe.refunds.v1",
        "stripe.disputes.v1",
        "stripe.customers.v1",
      ]),
    );
  });

  it("returns undefined for an unregistered schema (artifact waits for a parser)", () => {
    expect(interpreterForSchema("acme_neobank.warehouse_tx.v1")).toBeUndefined();
  });

  it("refuses duplicate registration", () => {
    expect(() => registerInterpreter("plaid.transactions_sync.v1", () => null)).toThrow(
      /already registered/,
    );
  });

  it("reshapes a plaid transactions/sync page into the plaid_tx_v1 payload", () => {
    const page = {
      accounts: [{ account_id: "a1", name: "Chase", type: "depository" }],
      added: [{ transaction_id: "t1", account_id: "a1", amount: 4.5, date: "2026-06-01" }],
      modified: [{ transaction_id: "t2", account_id: "a1", amount: 9, date: "2026-06-02" }],
      removed: [{ transaction_id: "t3" }],
      next_cursor: "c2",
      request_id: "req_x",
    };
    const out = interpreterForSchema("plaid.transactions_sync.v1")!(
      Buffer.from(JSON.stringify(page)),
      ctx({ sourceSchema: "plaid.transactions_sync.v1", sourceType: "plaid" }),
    );
    expect(out).not.toBeNull();
    expect(out!.parser).toBe("plaid_tx_v1");
    const extracted = out!.extracted as { accounts: unknown[]; transactions: unknown[] };
    expect(extracted.accounts).toHaveLength(1);
    // added + modified promoted; removed retained in raw only.
    expect(
      extracted.transactions.map((t) => (t as { transaction_id: string }).transaction_id),
    ).toEqual(["t1", "t2"]);
  });

  it("yields null for an empty plaid delta page", () => {
    const out = interpreterForSchema("plaid.transactions_sync.v1")!(
      Buffer.from(JSON.stringify({ added: [], modified: [], removed: [], next_cursor: "c" })),
      ctx({ sourceSchema: "plaid.transactions_sync.v1" }),
    );
    expect(out).toBeNull();
  });

  it("reshapes a stripe list page into the stripe_v1 payload with the account from context", () => {
    const page = {
      object: "list",
      data: [{ id: "txn_1", object: "balance_transaction", amount: -1250, currency: "usd" }],
      has_more: false,
    };
    const out = interpreterForSchema("stripe.balance_transactions.v1")!(
      Buffer.from(JSON.stringify(page)),
      ctx(),
    );
    expect(out!.parser).toBe("stripe_v1");
    expect(out!.extracted).toMatchObject({
      object_type: "balance_transaction",
      stripe_account_id: "acct_stripe1",
    });
    expect((out!.extracted as { objects: unknown[] }).objects).toHaveLength(1);
  });

  it("yields null for an empty stripe page", () => {
    const out = interpreterForSchema("stripe.charges.v1")!(
      Buffer.from(JSON.stringify({ object: "list", data: [], has_more: false })),
      ctx({ sourceSchema: "stripe.charges.v1" }),
    );
    expect(out).toBeNull();
  });

  it("throws on non-JSON bytes for a JSON schema", () => {
    expect(() =>
      interpreterForSchema("stripe.charges.v1")!(
        Buffer.from("%PDF-1.7 not json"),
        ctx({ sourceSchema: "stripe.charges.v1" }),
      ),
    ).toThrow(/not JSON/);
  });
});

describe("upload document interpreters", () => {
  it("registers the generic upload document schema", () => {
    expect(registeredSchemas()).toEqual(expect.arrayContaining([UPLOAD_DOCUMENT_SCHEMA]));
  });

  it("parses a bank statement text upload into document-sourced transactions", () => {
    const statement = [
      "June 2026 Statement",
      "06/01 ACH CREDIT Acme Customer 2,500.00 12,500.00",
      "06/02 POS Office Depot 120.45 12,379.55",
      "06/03 Payroll 1,750.00 10,629.55",
      "06/04 Interest Credit 4.12 10,633.67",
      "06/05 Card Stripe Fees 42.00 10,591.67",
    ].join("\n");
    const out = interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
      Buffer.from(statement),
      ctx({
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "pdf_upload",
        sourceRef: { account_id: "acct_upload", institution: "Mercury" },
        mimeType: "application/pdf",
      }),
    );
    expect(out!.parser).toBe("bank_statement_upload_v1");
    expect(out!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(out!.extracted).toMatchObject({
      object_type: "bank_statement",
      account: { account_id: "acct_upload", institution: "Mercury" },
    });
    const txs = (out!.extracted as { transactions: Array<{ direction: string }> }).transactions;
    expect(txs).toHaveLength(5);
    expect(txs.map((tx) => tx.direction)).toEqual([
      "inflow",
      "outflow",
      "outflow",
      "inflow",
      "outflow",
    ]);
  });

  it("parses transaction text from a simple PDF stream", () => {
    const out = interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
      makeMinimalPdf([
        "June 2026 Statement",
        "06/20 ACH CREDIT Split Customer 10.00 20.00 999.00",
        "06/21 Fee Adjustment 7.00 8.00 991.00",
        "Jun 22 Deposit Named Month 15.00",
      ]),
      ctx({
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "pdf_upload",
        sourceRef: { currency: "eur", bank_name: "Demo Bank" },
        mimeType: "application/pdf",
      }),
    );

    expect(out!.confidence).toBe(0.62);
    expect(out!.extracted).toMatchObject({
      account: { institution: "Demo Bank", currency: "EUR" },
    });
    const txs = (
      out!.extracted as {
        transactions: Array<{ amount: string; date: string; direction: string }>;
      }
    ).transactions;
    expect(txs).toEqual([
      expect.objectContaining({ amount: "20", date: "2026-06-20", direction: "inflow" }),
      expect.objectContaining({ amount: "7", date: "2026-06-21", direction: "outflow" }),
      expect.objectContaining({ amount: "15", date: "2026-06-22", direction: "inflow" }),
    ]);
  });

  it("parses the June demo bank statement PDF fixture end to end", () => {
    const out = uploadDocumentInterpreter(
      fixtureBytes("bank_statement_2026-06.pdf"),
      ctx({
        rawArtifactId: "raw_demo_bank",
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "pdf_upload",
        sourceRef: { account_id: "acct_demo", institution: "Demo Bank" },
        mimeType: "application/pdf",
      }),
    );

    expect(out!.parser).toBe("bank_statement_upload_v1");
    expect(out!.confidence).toBe(0.9);
    const extracted = out!.extracted as {
      account: { current_balance: string | null };
      transactions: Array<{
        amount: string;
        description: string;
        direction: "inflow" | "outflow";
        running_balance?: string;
      }>;
      parse_diagnostics: { rows_parsed: number; rows_with_balance: number };
    };
    expect(extracted.transactions).toHaveLength(19);
    expect(extracted.parse_diagnostics).toMatchObject({
      rows_parsed: 19,
      rows_with_balance: 19,
    });
    const net = extracted.transactions.reduce((sum, tx) => {
      const signed = tx.direction === "inflow" ? Number(tx.amount) : -Number(tx.amount);
      return sum + signed;
    }, 0);
    expect(net.toFixed(2)).toBe("-14586.02");
    expect(extracted.account.current_balance).toBe("398220.20");
    const reconstructedClosing = 412806.22 + net;
    expect(reconstructedClosing.toFixed(2)).toBe("398220.20");
    expect(extracted.transactions.at(-1)?.running_balance).toBe("398220.20");
  });

  it("throws on unsupported upload source types and empty bank statements", () => {
    expect(() =>
      interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
        Buffer.from("x"),
        ctx({ sourceSchema: UPLOAD_DOCUMENT_SCHEMA, sourceType: "other" }),
      ),
    ).toThrow(/does not support other/);
    expect(() =>
      interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
        Buffer.from("June 2026 Statement"),
        ctx({ sourceSchema: UPLOAD_DOCUMENT_SCHEMA, sourceType: "pdf_upload" }),
      ),
    ).toThrow(/contained no transaction rows/);
  });

  it("parses AR aging CSV rows into receivables", () => {
    const csv = [
      "Customer,Invoice Ref,Amount,Aging Bucket,Due Date",
      "Acme Co,INV-100,1200.50,31-60,2026-07-15",
      "Beta LLC,INV-101,99.00,Current,2026-07-30",
    ].join("\n");
    const out = interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
      Buffer.from(csv),
      ctx({
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "csv_upload",
        mimeType: "text/csv",
      }),
    );
    expect(out!.parser).toBe("document_records_upload_v1");
    expect(out!.extracted).toMatchObject({ object_type: "ar_aging" });
    expect((out!.extracted as { receivables: unknown[] }).receivables).toHaveLength(2);
  });

  it("parses the June demo AR aging XLSX fixture end to end", () => {
    const out = uploadDocumentInterpreter(
      fixtureBytes("ar_aging_2026-06-30.xlsx"),
      ctx({
        rawArtifactId: "raw_demo_ar",
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "csv_upload",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );

    expect(out!.parser).toBe("document_records_upload_v1");
    const extracted = out!.extracted as {
      object_type: string;
      receivables: Array<{ invoice_ref: string; amount: string; aging_bucket: string | null }>;
    };
    expect(extracted.object_type).toBe("ar_aging");
    expect(extracted.receivables.map((r) => r.invoice_ref)).toEqual([
      "NL-2417",
      "NL-2389",
      "NL-2440",
      "NL-2426",
      "NL-2402",
      "NL-2371",
      "NL-2444",
      "NL-2447",
    ]);
    expect(extracted.receivables.every((r) => /^NL-\d+$/.test(r.invoice_ref))).toBe(true);
    expect(extracted.receivables.every((r) => Number(r.amount) > 0)).toBe(true);
    expect(extracted.receivables.map((r) => r.amount)).toEqual([
      "49000",
      "12400",
      "21600",
      "8925",
      "17300",
      "31150",
      "14780",
      "9310",
    ]);
  });

  it("parses quoted and bucket-style AR aging rows with low confidence", () => {
    const csv = [
      "Customer,Invoice Ref,Current,31-60,Currency,Status",
      '"Acme ""Quoted"" Co",INV-Q,0,321.10,eur,open',
      ",INV-SKIP,10,0,usd,open",
      ",INV-SKIP-2,0,10,usd,open",
    ].join("\n");
    const out = interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
      Buffer.from(csv),
      ctx({
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "csv_upload",
        mimeType: "text/csv",
      }),
    );

    expect(out!.confidence).toBe(0.48);
    expect(out!.extracted).toMatchObject({
      object_type: "ar_aging",
      receivables: [
        {
          counterparty_name: 'Acme "Quoted" Co',
          invoice_ref: "INV-Q",
          amount: "321.10",
          currency: "EUR",
          aging_bucket: "31-60",
          status: "open",
        },
      ],
    });
  });

  it("throws when spreadsheet headers match AR aging but no receivable rows parse", () => {
    expect(() =>
      interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
        Buffer.from("Customer,Invoice Ref,Amount\n,INV-EMPTY,"),
        ctx({
          sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
          sourceType: "csv_upload",
          mimeType: "text/csv",
        }),
      ),
    ).toThrow(/contained no receivable rows/);
  });

  it("parses payroll register CSV rows into payroll obligations", () => {
    const csv = [
      "Pay Run,Net Pay,Tax Amount,Pay Date,Cadence",
      "RUN-2026-06-15,9000,2100,2026-06-15,biweekly",
    ].join("\n");
    const out = interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
      Buffer.from(csv),
      ctx({
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "csv_upload",
        mimeType: "text/csv",
      }),
    );
    expect(out!.parser).toBe("document_records_upload_v1");
    expect(out!.extracted).toMatchObject({ object_type: "payroll_register" });
    expect(out!.extracted).toMatchObject({
      obligations: [{ run_ref: "RUN-2026-06-15", amount: "9000", tax_amount: "2100" }],
    });
  });

  it("parses the June demo payroll register XLSX fixture as run-level obligations", () => {
    const out = uploadDocumentInterpreter(
      fixtureBytes("payroll_register_2026-06.xlsx"),
      ctx({
        rawArtifactId: "raw_demo_payroll",
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "csv_upload",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );

    expect(out!.parser).toBe("document_records_upload_v1");
    const extracted = out!.extracted as {
      object_type: string;
      obligations: Array<{
        counterparty_name: string;
        run_ref: string;
        amount: string;
        net_amount: string | null;
        tax_amount: string | null;
      }>;
    };
    expect(extracted.object_type).toBe("payroll_register");
    expect(extracted.obligations).toHaveLength(2);
    expect(extracted.obligations).toEqual([
      expect.objectContaining({
        counterparty_name: "Payroll",
        run_ref: "2026-06A",
        amount: "29612.42",
        net_amount: "29612.42",
        tax_amount: "14902.36",
      }),
      expect.objectContaining({
        counterparty_name: "Payroll",
        run_ref: "2026-06B",
        amount: "29612.42",
        net_amount: "29612.42",
        tax_amount: "14902.36",
      }),
    ]);
    expect(JSON.stringify(out!.extracted)).not.toContain("Amara Osei");
    expect(JSON.stringify(out!.extracted)).not.toContain("E-1001");
  });

  it("parses payroll gross fallback and reports unparseable payroll rows", () => {
    const out = interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
      Buffer.from("Payroll Run,Gross Pay,Pay Date\nRUN-GROSS,1234.56,2026-06-30"),
      ctx({
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "csv_upload",
        mimeType: "text/csv",
      }),
    );
    expect(out!.extracted).toMatchObject({
      object_type: "payroll_register",
      obligations: [
        {
          run_ref: "RUN-GROSS",
          amount: "1234.56",
          net_amount: null,
          tax_amount: null,
          due_date: "2026-06-30",
          cadence: "unknown",
        },
      ],
    });

    expect(() =>
      interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
        Buffer.from("Pay Run,Net Pay\nRUN-NO-AMOUNT,"),
        ctx({
          sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
          sourceType: "csv_upload",
          mimeType: "text/csv",
        }),
      ),
    ).toThrow(/payroll register upload contained no payroll rows/);
  });

  it("throws on spreadsheets with parseable rows but unknown headers", () => {
    expect(() =>
      interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
        Buffer.from("Name,Value\nA,1"),
        ctx({
          sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
          sourceType: "csv_upload",
          mimeType: "text/csv",
        }),
      ),
    ).toThrow(/did not match AR aging or payroll register headers/);
  });

  it("throws on empty upload spreadsheets so interpretation failures are logged", () => {
    expect(() =>
      interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
        Buffer.from("Customer,Invoice Ref,Amount\n"),
        ctx({
          sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
          sourceType: "csv_upload",
          mimeType: "text/csv",
        }),
      ),
    ).toThrow(/no parseable data rows/);
  });

  it("parses XLSX upload bytes with the csv_upload source type", () => {
    const bytes = makeXlsxRows([
      ["Customer", "Invoice Ref", "Amount", "Aging Bucket"],
      ["Acme & Co", "INV-XLSX-1", "250.25", "Current"],
    ]);

    const out = interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
      bytes,
      ctx({
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "csv_upload",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );

    expect(out!.parser).toBe("document_records_upload_v1");
    expect(out!.extracted).toMatchObject({
      object_type: "ar_aging",
      receivables: [{ invoice_ref: "INV-XLSX-1", amount: "250.25" }],
    });
  });

  it("parses deflated XLSX shared strings, raw values, and booleans", () => {
    const sharedStrings = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      "<si><t>Customer</t></si>",
      "<si><t>Invoice Ref</t></si>",
      "<si><t>Amount</t></si>",
      "<si><t>Status</t></si>",
      "<si><t>Shared Customer</t></si>",
      "<si><t>INV-SHARED</t></si>",
      "</sst>",
    ].join("");
    const sheetRows = [
      '<row r="1">',
      '<c r="A1" t="s"><v>0</v></c>',
      '<c r="B1" t="s"><v>1</v></c>',
      '<c r="C1" t="s"><v>2</v></c>',
      '<c r="D1" t="s"><v>3</v></c>',
      "</row>",
      '<row r="2">',
      '<c r="A2" t="s"><v>4</v></c>',
      '<c r="B2" t="s"><v>5</v></c>',
      '<c r="C2"><v>77.70</v></c>',
      '<c r="D2" t="b"><v>1</v></c>',
      "</row>",
    ].join("");

    const out = interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
      makeXlsxWithSheet(sheetRows, { deflate: true, sharedStrings }),
      ctx({
        sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
        sourceType: "csv_upload",
        mimeType: "application/vnd.ms-excel",
      }),
    );

    expect(out!.extracted).toMatchObject({
      object_type: "ar_aging",
      receivables: [
        {
          counterparty_name: "Shared Customer",
          invoice_ref: "INV-SHARED",
          amount: "77.70",
          status: "TRUE",
        },
      ],
    });
  });

  it("throws on XLSX files without a readable worksheet", () => {
    const bytes = makeZip({ "xl/not-a-sheet.xml": "<xml />" });
    expect(() =>
      interpreterForSchema(UPLOAD_DOCUMENT_SCHEMA)!(
        bytes,
        ctx({
          sourceSchema: UPLOAD_DOCUMENT_SCHEMA,
          sourceType: "csv_upload",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      ),
    ).toThrow(/no parseable data rows/);
  });
});

describe("merge accounting interpreters", () => {
  it("reshapes a Merge list page into the merge_accounting_v1 payload with the integration", () => {
    const page = {
      next: "cur_2",
      results: [{ id: "inv_1", type: "ACCOUNTS_PAYABLE", modified_at: "2026-06-01T00:00:00Z" }],
    };
    const out = interpreterForSchema("merge_accounting.invoices.v1")!(
      Buffer.from(JSON.stringify(page)),
      ctx({
        sourceSchema: "merge_accounting.invoices.v1",
        sourceType: "merge_accounting",
        sourceRef: { merge_integration: "NetSuite" },
        objectType: "invoice",
      }),
    );
    expect(out!.parser).toBe("merge_accounting_v1");
    expect(out!.extracted).toMatchObject({ object_type: "invoice", merge_integration: "NetSuite" });
    expect((out!.extracted as { objects: unknown[] }).objects).toHaveLength(1);
  });

  it("registers all six Merge page schemas and yields null on empty pages", () => {
    const schemas = [
      "merge_accounting.gl_accounts.v1",
      "merge_accounting.journal_entries.v1",
      "merge_accounting.invoices.v1",
      "merge_accounting.contacts.v1",
      "merge_accounting.payments.v1",
      "merge_accounting.tax_rates.v1",
    ];
    expect(registeredSchemas()).toEqual(expect.arrayContaining(schemas));
    for (const schema of schemas) {
      const out = interpreterForSchema(schema)!(
        Buffer.from(JSON.stringify({ next: null, results: [] })),
        ctx({ sourceSchema: schema, sourceType: "merge_accounting" }),
      );
      expect(out).toBeNull();
    }
  });
});

describe("finch interpreters (PII minimization)", () => {
  it("promotes directory and payments pages but NOT company or pay statements", () => {
    expect(registeredSchemas()).toEqual(
      expect.arrayContaining(["finch.directory.v1", "finch.payments.v1"]),
    );
    // Compensation/identity detail stays encrypted in the raw blob only.
    expect(interpreterForSchema("finch.pay_statements.v1")).toBeUndefined();
    expect(interpreterForSchema("finch.company.v1")).toBeUndefined();
  });

  it("reshapes a directory page into individual objects", () => {
    const out = interpreterForSchema("finch.directory.v1")!(
      Buffer.from(JSON.stringify({ individuals: [{ id: "ind_1", first_name: "Dana" }] })),
      ctx({ sourceSchema: "finch.directory.v1", sourceType: "finch" }),
    );
    expect(out!.parser).toBe("finch_payroll_v1");
    expect(out!.extracted).toMatchObject({ object_type: "individual" });
  });

  it("reshapes a top-level payments array into pay_run objects", () => {
    const out = interpreterForSchema("finch.payments.v1")!(
      Buffer.from(JSON.stringify([{ id: "pay_1", pay_date: "2026-06-05" }])),
      ctx({ sourceSchema: "finch.payments.v1", sourceType: "finch" }),
    );
    expect(out!.parser).toBe("finch_payroll_v1");
    expect(out!.extracted).toMatchObject({ object_type: "pay_run" });
    expect((out!.extracted as { objects: unknown[] }).objects).toHaveLength(1);
  });
});
