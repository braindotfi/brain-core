import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS,
  classifyInvoiceRepair,
  classifyTransactionCategoryRepair,
  repairPolicyContent,
} from "../ops/repair-northstar-canonical-seed.mjs";

const legacyPolicy = {
  version: 1,
  seed_key: "northstar_labs_v1",
  lists: { "vendors.approved": ["cp_1", "cp_2", "cp_3", "cp_4", "cp_5"] },
  rules: [
    {
      id: "northstar-ap-auto-approved",
      execute: "auto",
      when: {
        "counterparty.in": "vendors.approved",
        "agent.risk_level.lte": "low",
      },
    },
  ],
};

test("repairs only the legacy Northstar policy allowlist key", () => {
  const result = repairPolicyContent(legacyPolicy);
  assert.equal(result.changed, true);
  assert.equal(result.content.lists["vendors.approved"], undefined);
  assert.deepEqual(result.content.lists["vendors.policy_allowlisted"], [
    "cp_1",
    "cp_2",
    "cp_3",
    "cp_4",
    "cp_5",
  ]);
  assert.equal(result.content.rules[0].when["counterparty.in"], "vendors.policy_allowlisted");
  assert.equal(legacyPolicy.lists["vendors.approved"].length, 5);
});

test("classifies only unmarked fixture receivables for patching", () => {
  const invoices = NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS.map((invoice_number, index) => ({
    id: `inv_${index}`,
    invoice_number,
    amount_due: ["96000", "120000", "184000", "72000", "58500"][index],
    metadata: index === 0 ? { scenario: "ar" } : {},
  }));
  assert.deepEqual(classifyInvoiceRepair(invoices), ["inv_1", "inv_2", "inv_3", "inv_4"]);
});

test("refuses a conflicting invoice scenario instead of overwriting it", () => {
  const invoices = NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS.map((invoice_number, index) => ({
    id: `inv_${index}`,
    invoice_number,
    amount_due: ["96000", "120000", "184000", "72000", "58500"][index],
    metadata: index === 2 ? { scenario: "ap" } : {},
  }));
  assert.throws(() => classifyInvoiceRepair(invoices), /unexpected scenario marker/);
});

test("repairs only the exact unassigned canonical Northstar transaction set", () => {
  const kinds = {
    revenue: "income.subscription_revenue",
    payroll: "expense.payroll_and_benefits",
    cloud: "expense.cloud_infrastructure",
    operating: "expense.general_and_administrative",
  };
  const months = [
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
  ];
  const rows = months.flatMap((month) =>
    Object.entries(kinds).map(([kind, canonicalCode], index) => ({
      id: `txn_${month}_${kind}`,
      external_transaction_id: `northstar:${month}:${kind}`,
      category_id: index === 0 ? `cat_${kind}` : null,
      active_category_id: index === 0 ? `cat_${kind}` : null,
      canonical_code: index === 0 ? canonicalCode : null,
    })),
  );

  const repairs = classifyTransactionCategoryRepair(rows);
  assert.equal(repairs.length, 36);
  assert.deepEqual(repairs[0], {
    id: "txn_2025-09_payroll",
    externalTransactionId: "northstar:2025-09:payroll",
    canonicalCode: "expense.payroll_and_benefits",
  });
});

test("refuses an unexpected historical category rather than overwriting it", () => {
  const kinds = ["revenue", "payroll", "cloud", "operating"];
  const months = [
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
  ];
  const rows = months.flatMap((month) =>
    kinds.map((kind) => ({
      id: `txn_${month}_${kind}`,
      external_transaction_id: `northstar:${month}:${kind}`,
      category_id: null,
      active_category_id: null,
      canonical_code: null,
    })),
  );
  rows[0] = {
    ...rows[0],
    category_id: "cat_wrong",
    active_category_id: "cat_wrong",
    canonical_code: "expense.cloud_infrastructure",
  };
  assert.throws(() => classifyTransactionCategoryRepair(rows), /unexpected category assignment/);
});

test("staging repair workflow has no production target and requires apply confirmation", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ops-repair-canonical-northstar-seed.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /VM_HOST_STAGING/);
  assert.doesNotMatch(workflow, /VM_HOST:\s*\$\{\{ secrets\.VM_HOST \}\}/);
  assert.match(workflow, /REPAIR_CANONICAL_NORTHSTAR_SEED/);
  assert.match(workflow, /northstar_canonical_repair_apply_completed/);
  assert.match(workflow, /northstar_canonical_repair_report_completed/);
  assert.match(workflow, /2>&1/);
  assert.match(workflow, /Northstar repair command exited with status/);
});
