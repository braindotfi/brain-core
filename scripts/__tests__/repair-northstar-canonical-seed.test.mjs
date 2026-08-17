import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS,
  classifyInvoiceRepair,
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
      when: { "counterparty.in": "vendors.approved" },
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
