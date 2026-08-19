export const NORTHSTAR_SEED_KEY = "northstar_labs_v1";

export type CounterpartyFixture = {
  key: string;
  name: string;
  type: "vendor" | "customer" | "tax_authority";
  riskLevel: "low" | "medium" | "high";
  verifiedStatus: "document_verified" | "sanctions_cleared" | "unverified";
};

export const NORTHSTAR_COUNTERPARTIES: readonly CounterpartyFixture[] = [
  {
    key: "cascade",
    name: "Cascade Compute",
    type: "vendor",
    riskLevel: "low",
    verifiedStatus: "sanctions_cleared",
  },
  {
    key: "atlas",
    name: "Atlas Cloud Infrastructure",
    type: "vendor",
    riskLevel: "low",
    verifiedStatus: "sanctions_cleared",
  },
  {
    key: "meridian",
    name: "Meridian Benefits",
    type: "vendor",
    riskLevel: "low",
    verifiedStatus: "document_verified",
  },
  {
    key: "redwood",
    name: "Redwood Legal",
    type: "vendor",
    riskLevel: "low",
    verifiedStatus: "document_verified",
  },
  {
    key: "fathom",
    name: "Fathom Security",
    type: "vendor",
    riskLevel: "medium",
    verifiedStatus: "document_verified",
  },
  {
    key: "irs",
    name: "Internal Revenue Service",
    type: "tax_authority",
    riskLevel: "low",
    verifiedStatus: "document_verified",
  },
  {
    key: "gridline",
    name: "Gridline Labs",
    type: "vendor",
    riskLevel: "high",
    verifiedStatus: "unverified",
  },
  {
    key: "helio",
    name: "Helio Manufacturing",
    type: "customer",
    riskLevel: "low",
    verifiedStatus: "document_verified",
  },
  {
    key: "apex",
    name: "Apex Health",
    type: "customer",
    riskLevel: "low",
    verifiedStatus: "document_verified",
  },
  {
    key: "kestrel",
    name: "Kestrel Logistics",
    type: "customer",
    riskLevel: "low",
    verifiedStatus: "sanctions_cleared",
  },
  {
    key: "vertex",
    name: "Vertex Retail",
    type: "customer",
    riskLevel: "medium",
    verifiedStatus: "document_verified",
  },
  {
    key: "horizon",
    name: "Horizon Finance",
    type: "customer",
    riskLevel: "low",
    verifiedStatus: "sanctions_cleared",
  },
] as const;

const REVENUE = [
  280000, 295000, 305000, 320000, 335000, 350000, 370000, 385000, 400000, 420000, 440000, 460000,
] as const;
const PAYROLL = [
  118000, 120000, 122000, 124000, 126000, 130000, 132000, 135000, 138000, 140000, 142000, 145000,
] as const;
const CLOUD = [
  48000, 49000, 50000, 52000, 54000, 56000, 58000, 61000, 64000, 68000, 72000, 78000,
] as const;
const OTHER = [
  58000, 59000, 60000, 61000, 62000, 63000, 64000, 66000, 68000, 70000, 72000, 75000,
] as const;

export type NorthstarPayableFixture = readonly [
  counterpartyKey: string,
  invoiceNumber: string,
  amount: string,
  dueDate: string,
  type: "subscription" | "payroll" | "bill" | "tax",
];

export type NorthstarReceivableFixture = readonly [
  counterpartyKey: string,
  invoiceNumber: string,
  amount: string,
  issueDate: string,
  dueDate: string,
  status: "overdue" | "sent",
];

export type NorthstarFixture = {
  asOf: Date;
  asOfIso: string;
  monthlyCashFlow: ReadonlyArray<{
    month: string;
    transactionDate: string;
    revenue: number;
    payroll: number;
    cloud: number;
    other: number;
  }>;
  payables: readonly NorthstarPayableFixture[];
  receivables: readonly NorthstarReceivableFixture[];
};

function atUtcStartOfDay(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("Northstar as-of date is invalid");
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addUtcMonths(value: Date, months: number): Date {
  const next = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  return next;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function invoiceDateKey(value: Date): string {
  return dateOnly(value).replaceAll("-", "");
}

function receivableNumber(customer: string, value: Date): string {
  return `AR-${customer}-${value.toISOString().slice(0, 7)}`;
}

export function buildNorthstarFixture(asOf: Date = new Date()): NorthstarFixture {
  const anchor = atUtcStartOfDay(asOf);
  const payable = (
    key: string,
    amount: string,
    dueOffset: number,
    type: NorthstarPayableFixture[4],
  ): NorthstarPayableFixture => {
    const due = addUtcDays(anchor, dueOffset);
    return [key, `AP-${invoiceDateKey(due)}`, amount, dateOnly(due), type];
  };
  const receivable = (
    key: string,
    label: string,
    amount: string,
    issueOffset: number,
    dueOffset: number,
    status: NorthstarReceivableFixture[5],
  ): NorthstarReceivableFixture => {
    const issue = addUtcDays(anchor, issueOffset);
    return [
      key,
      receivableNumber(label, issue),
      amount,
      dateOnly(issue),
      dateOnly(addUtcDays(anchor, dueOffset)),
      status,
    ];
  };

  return {
    asOf: anchor,
    asOfIso: anchor.toISOString(),
    monthlyCashFlow: REVENUE.map((revenue, index) => {
      const transactionDate = addUtcMonths(anchor, index - 11);
      return {
        month: transactionDate.toISOString().slice(0, 7),
        transactionDate: transactionDate.toISOString(),
        revenue,
        payroll: PAYROLL[index]!,
        cloud: CLOUD[index]!,
        other: OTHER[index]!,
      };
    }),
    payables: [
      payable("cascade", "86400.00", 4, "subscription"),
      payable("atlas", "42800.00", 7, "subscription"),
      payable("meridian", "31250.00", 15, "payroll"),
      payable("redwood", "12000.00", 17, "bill"),
      payable("fathom", "9600.00", 3, "subscription"),
      payable("irs", "24750.00", 31, "tax"),
      payable("gridline", "14500.00", 5, "bill"),
    ],
    receivables: [
      receivable("helio", "HELIO", "184000.00", -75, -42, "overdue"),
      receivable("apex", "APEX", "96000.00", -56, -12, "overdue"),
      receivable("kestrel", "KESTREL", "72000.00", -26, 10, "sent"),
      receivable("vertex", "VERTEX", "58500.00", -21, 0, "sent"),
      receivable("horizon", "HORIZON", "120000.00", -18, 17, "sent"),
    ],
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export const NORTHSTAR_EXPECTED = {
  openPayables: "221300.00",
  openReceivables: "530500.00",
  overdueReceivables: "280000.00",
  revenue: sum(REVENUE),
  outflow: sum(PAYROLL) + sum(CLOUD) + sum(OTHER),
  netCashFlow: sum(REVENUE) - sum(PAYROLL) - sum(CLOUD) - sum(OTHER),
  latestMonthNetCashFlow: REVENUE[11]! - PAYROLL[11]! - CLOUD[11]! - OTHER[11]!,
} as const;

export function validateNorthstarFixture(fixture: NorthstarFixture): void {
  const payableTotal = fixture.payables.reduce((total, row) => total + Number(row[2]), 0);
  const receivableTotal = fixture.receivables.reduce((total, row) => total + Number(row[2]), 0);
  const overdueTotal = fixture.receivables
    .filter((row) => row[5] === "overdue")
    .reduce((total, row) => total + Number(row[2]), 0);
  if (
    payableTotal.toFixed(2) !== NORTHSTAR_EXPECTED.openPayables ||
    receivableTotal.toFixed(2) !== NORTHSTAR_EXPECTED.openReceivables ||
    overdueTotal.toFixed(2) !== NORTHSTAR_EXPECTED.overdueReceivables ||
    NORTHSTAR_EXPECTED.netCashFlow !== 1300000 ||
    NORTHSTAR_EXPECTED.latestMonthNetCashFlow !== 162000 ||
    fixture.monthlyCashFlow.length !== 12
  ) {
    throw new Error("Northstar fixture totals do not match the canonical scenario");
  }
}
