#!/usr/bin/env node
/**
 * Materialize the Meridian-shaped CSV fixture set for the staging-only custom
 * ingestion smoke. The set is intentionally core-owned so it proves the
 * declared CSV contract without depending on a client-side uploader.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const STAGING_CUSTOMER_ASSERTED_CSV_FIXTURES = Object.freeze([
  {
    filename: "counterparties.csv",
    objectType: "counterparties",
    body: `counterparty_id,name,type,category,payment_terms,first_seen
vnd_vertex_cloud,Vertex Cloud Systems,vendor,cloud_hosting,Net 30,2026-01-04
vnd_northgate_logistics,Northgate Logistics,vendor,logistics,Net 30,2026-02-11
vnd_alpine_legal,Alpine Legal Group,vendor,legal_services,Net 30,2026-03-02
vnd_steelframe_mfg,Steelframe Manufacturing Co,vendor,manufacturing_parts,Net 30,2026-01-20
vnd_bayline_insurance,Bayline Insurance Partners,vendor,insurance,Net 30,2026-01-01
vnd_solstice_office,Solstice Office Supplies,vendor,office_supplies,Net 30,2026-08-05
cus_orbit_dynamics,Orbit Dynamics LLC,customer,,,2026-01-15
cus_falcon_freight,Falcon Freight Corp,customer,,,2026-02-01
cus_solace_health,Solace Health Systems,customer,,,2026-01-10
cus_ridgeline_ventures,Ridgeline Ventures,customer,,,2026-03-20
tax_irs,Internal Revenue Service,tax_authority,,,,
`,
  },
  {
    filename: "payables_invoices.csv",
    objectType: "payables_invoices",
    body: `invoice_id,counterparty_id,amount,currency,issued_date,due_date,status,paid_date
INV-VCS-2201,vnd_vertex_cloud,8400.00,USD,2026-05-01,2026-05-31,paid,2026-05-28
INV-VCS-2214,vnd_vertex_cloud,8400.00,USD,2026-06-01,2026-06-30,paid,2026-06-25
INV-VCS-2227,vnd_vertex_cloud,9150.00,USD,2026-07-01,2026-07-31,open,
INV-VCS-2241,vnd_vertex_cloud,9150.00,USD,2026-08-01,2026-08-31,open,
INV-NGL-0110,vnd_northgate_logistics,4275.50,USD,2026-05-10,2026-06-09,paid,2026-06-05
INV-NGL-0132,vnd_northgate_logistics,5120.00,USD,2026-06-12,2026-07-12,paid,2026-07-08
INV-NGL-0155,vnd_northgate_logistics,6830.25,USD,2026-07-15,2026-08-14,open,
INV-ALG-3301,vnd_alpine_legal,12500.00,USD,2026-06-01,2026-06-30,open,
INV-ALG-3315,vnd_alpine_legal,7250.00,USD,2026-07-05,2026-08-04,open,
INV-SFM-7701,vnd_steelframe_mfg,22400.00,USD,2026-05-20,2026-06-19,paid,2026-06-15
INV-SFM-7725,vnd_steelframe_mfg,18600.00,USD,2026-07-01,2026-07-31,paid,2026-07-28
INV-SFM-7740,vnd_steelframe_mfg,24900.00,USD,2026-08-02,2026-09-01,open,
INV-BIP-0090,vnd_bayline_insurance,3600.00,USD,2026-06-01,2026-06-30,paid,2026-06-20
INV-BIP-0102,vnd_bayline_insurance,3600.00,USD,2026-07-01,2026-07-31,open,
INV-SOS-0001,vnd_solstice_office,1240.00,USD,2026-08-05,2026-09-04,open,
`,
  },
  {
    filename: "receivables_invoices.csv",
    objectType: "receivables_invoices",
    body: `invoice_id,counterparty_id,amount,currency,issued_date,due_date,status,paid_date
INV-OD-1001,cus_orbit_dynamics,15000.00,USD,2026-05-15,2026-06-14,paid,2026-06-10
INV-OD-1022,cus_orbit_dynamics,18500.00,USD,2026-06-20,2026-07-20,paid,2026-07-15
INV-OD-1045,cus_orbit_dynamics,21300.00,USD,2026-07-25,2026-08-24,open,
INV-FF-2201,cus_falcon_freight,9800.00,USD,2026-06-01,2026-06-30,open,
INV-FF-2218,cus_falcon_freight,11200.00,USD,2026-07-10,2026-08-09,open,
INV-SH-0501,cus_solace_health,32000.00,USD,2026-05-01,2026-05-31,paid,2026-05-25
INV-SH-0522,cus_solace_health,27500.00,USD,2026-07-01,2026-07-31,open,
INV-RV-0810,cus_ridgeline_ventures,6400.00,USD,2026-06-15,2026-07-15,open,
`,
  },
  {
    filename: "payroll_runs.csv",
    objectType: "payroll_runs",
    body: `run_id,period,gross_amount,currency,status,paid_date,scheduled_date
PR-2026-06,2026-06,142500.00,USD,paid,2026-06-28,
PR-2026-07,2026-07,148900.00,USD,paid,2026-07-28,
PR-2026-08,2026-08,,USD,scheduled,,2026-08-28
`,
  },
  {
    filename: "tax_obligations.csv",
    objectType: "tax_obligations",
    body: `obligation_id,counterparty_id,description,amount,currency,due_date,status,paid_date
TAX-Q2-2026,tax_irs,Q2 2026 Federal Estimated Tax,54000.00,USD,2026-06-15,paid,2026-06-15
TAX-Q3-2026,tax_irs,Q3 2026 Federal Estimated Tax,58200.00,USD,2026-09-15,open,
`,
  },
]);

export function writeStagingCustomerAssertedCsvSmokeFixtures(outputDir) {
  const resolved = resolve(outputDir);
  mkdirSync(resolved, { recursive: true });
  return STAGING_CUSTOMER_ASSERTED_CSV_FIXTURES.map((fixture) => {
    const path = resolve(resolved, fixture.filename);
    writeFileSync(path, fixture.body, "utf8");
    return { filename: fixture.filename, object_type: fixture.objectType, path };
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const outputIndex = process.argv.indexOf("--output-dir");
  const outputDir = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    throw new Error(
      "usage: write-staging-customer-asserted-csv-smoke-fixtures.mjs --output-dir <path>",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ fixtures: writeStagingCustomerAssertedCsvSmokeFixtures(outputDir) })}\n`,
  );
}
