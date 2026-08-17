export const NORTHSTAR_AS_OF = "2026-08-15T12:00:00.000Z";
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

export const NORTHSTAR_PAYABLES = [
  ["cascade", "AP-2026-0819", "86400.00", "2026-08-19", "subscription"],
  ["atlas", "AP-2026-0822", "42800.00", "2026-08-22", "subscription"],
  ["meridian", "AP-2026-0830", "31250.00", "2026-08-30", "payroll"],
  ["redwood", "AP-2026-0901", "12000.00", "2026-09-01", "bill"],
  ["fathom", "AP-2026-0818", "9600.00", "2026-08-18", "subscription"],
  ["irs", "AP-2026-0915", "24750.00", "2026-09-15", "tax"],
  ["gridline", "AP-2026-0820", "14500.00", "2026-08-20", "bill"],
] as const;

export const NORTHSTAR_RECEIVABLES = [
  ["helio", "AR-HELIO-2026-07", "184000.00", "2026-06-01", "2026-07-04", "overdue"],
  ["apex", "AR-APEX-2026-07", "96000.00", "2026-06-20", "2026-08-03", "overdue"],
  ["kestrel", "AR-KESTREL-2026-08", "72000.00", "2026-07-20", "2026-08-25", "sent"],
  ["vertex", "AR-VERTEX-2026-08", "58500.00", "2026-07-25", "2026-08-15", "sent"],
  ["horizon", "AR-HORIZON-2026-08", "120000.00", "2026-07-28", "2026-09-01", "sent"],
] as const;

const MONTHS = [
  "2025-09",
  "2025-10",
  "2025-11",
  "2025-12",
  "2026-01",
  "2026-02",
  "2026-03",
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
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

export const NORTHSTAR_MONTHLY_CASH_FLOW = MONTHS.map((month, index) => ({
  month,
  revenue: REVENUE[index]!,
  payroll: PAYROLL[index]!,
  cloud: CLOUD[index]!,
  other: OTHER[index]!,
}));

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
  augustNetCashFlow: REVENUE[11]! - PAYROLL[11]! - CLOUD[11]! - OTHER[11]!,
} as const;

export function validateNorthstarFixture(): void {
  const payableTotal = NORTHSTAR_PAYABLES.reduce((total, row) => total + Number(row[2]), 0);
  const receivableTotal = NORTHSTAR_RECEIVABLES.reduce((total, row) => total + Number(row[2]), 0);
  const overdueTotal = NORTHSTAR_RECEIVABLES.filter((row) => row[5] === "overdue").reduce(
    (total, row) => total + Number(row[2]),
    0,
  );
  if (
    payableTotal.toFixed(2) !== NORTHSTAR_EXPECTED.openPayables ||
    receivableTotal.toFixed(2) !== NORTHSTAR_EXPECTED.openReceivables ||
    overdueTotal.toFixed(2) !== NORTHSTAR_EXPECTED.overdueReceivables ||
    NORTHSTAR_EXPECTED.netCashFlow !== 1300000 ||
    NORTHSTAR_EXPECTED.augustNetCashFlow !== 162000
  ) {
    throw new Error("Northstar fixture totals do not match the canonical scenario");
  }
}
