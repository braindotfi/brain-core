/**
 * Repairs the pre-#680 Northstar staging tenant in place.
 *
 * The purpose-built Northstar seeder rejects nonempty tenants before writing,
 * so re-running it cannot repair the original presenter tenant. This script
 * has one fixed tenant and no free-form identifiers. It patches only the five
 * receivable invoice metadata documents and the unsigned active Northstar
 * policy's list key and trusted agent-risk bound, then records one idempotent
 * repair audit event.
 *
 * Default mode is read-only. Pass --apply only through the staging-only
 * workflow after its constrained preflight succeeds.
 */

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { contentHash } from "@brain/policy";
import { PostgresAuditEmitter } from "@brain/shared";

export const NORTHSTAR_TENANT_ID = "tnt_01M08J9B75QH08MCVA884N57VB";
export const NORTHSTAR_TEST_EMAIL = "braindotfi+test1@gmail.com";
export const NORTHSTAR_SEED_KEY = "northstar_labs_v1";
export const NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS = [
  "AR-HELIO-2026-07",
  "AR-APEX-2026-07",
  "AR-KESTREL-2026-08",
  "AR-VERTEX-2026-08",
  "AR-HORIZON-2026-08",
];

const EXPECTED_AR_TOTAL = "530500.00000000";
const REPAIR_IDEMPOTENCY_KEY = "northstar_labs_v1:canonical-repair:v2";
const NORTHSTAR_MONTHS = [
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
const NORTHSTAR_TRANSACTION_CATEGORY_BY_KIND = {
  revenue: "income.subscription_revenue",
  payroll: "expense.payroll_and_benefits",
  cloud: "expense.cloud_infrastructure",
  operating: "expense.general_and_administrative",
};

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} content */
export function repairPolicyContent(content) {
  if (!isObject(content) || !isObject(content.lists) || !Array.isArray(content.rules)) {
    throw new Error("active Northstar policy has an unexpected document shape");
  }

  const next = structuredClone(content);
  const lists = next.lists;
  const legacyList = lists["vendors.approved"];
  const repairedList = lists["vendors.policy_allowlisted"];

  if (legacyList !== undefined && repairedList !== undefined) {
    throw new Error("Northstar policy contains both legacy and repaired allowlist keys");
  }
  if (legacyList !== undefined) {
    if (
      !Array.isArray(legacyList) ||
      legacyList.length !== 5 ||
      !legacyList.every((id) => typeof id === "string")
    ) {
      throw new Error("legacy Northstar allowlist has an unexpected value");
    }
    delete lists["vendors.approved"];
    lists["vendors.policy_allowlisted"] = legacyList;
  }

  const autoRule = next.rules.find(
    (rule) => isObject(rule) && rule.id === "northstar-ap-auto-approved",
  );
  if (!isObject(autoRule) || !isObject(autoRule.when) || autoRule.execute !== "auto") {
    throw new Error("Northstar auto-approval rule is missing or malformed");
  }
  const ruleList = autoRule.when["counterparty.in"];
  if (legacyList !== undefined && ruleList !== "vendors.approved") {
    throw new Error("Northstar auto-approval rule does not reference the legacy allowlist");
  }
  if (legacyList !== undefined) autoRule.when["counterparty.in"] = "vendors.policy_allowlisted";

  const storedRiskBound = autoRule.when["agent.risk_level.lte"];
  if (storedRiskBound !== "low" && storedRiskBound !== "medium") {
    throw new Error("Northstar auto-approval rule has an unexpected agent risk bound");
  }
  if (storedRiskBound === "low") autoRule.when["agent.risk_level.lte"] = "medium";

  const storedAchCap = autoRule.ach_autonomous_max_amount;
  if (
    storedAchCap !== undefined &&
    (!isObject(storedAchCap) ||
      storedAchCap.currency !== "USD" ||
      storedAchCap.value !== "10000.00")
  ) {
    throw new Error("Northstar auto-approval rule has an unexpected ACH autonomy cap");
  }
  if (storedAchCap === undefined) {
    autoRule.ach_autonomous_max_amount = { currency: "USD", value: "10000.00" };
  }

  if (
    !Array.isArray(lists["vendors.policy_allowlisted"]) ||
    lists["vendors.policy_allowlisted"].length !== 5 ||
    autoRule.when["counterparty.in"] !== "vendors.policy_allowlisted" ||
    autoRule.when["agent.risk_level.lte"] !== "medium" ||
    !isObject(autoRule.ach_autonomous_max_amount) ||
    autoRule.ach_autonomous_max_amount.currency !== "USD" ||
    autoRule.ach_autonomous_max_amount.value !== "10000.00"
  ) {
    throw new Error("Northstar repaired policy does not have the expected allowlist");
  }

  return {
    content: next,
    listRenamed: legacyList !== undefined,
    riskBoundUpdated: storedRiskBound === "low",
    achCapAdded: storedAchCap === undefined,
    changed: legacyList !== undefined || storedRiskBound === "low" || storedAchCap === undefined,
  };
}

/** @param {Array<{ id: string, invoice_number: string, amount_due: string, metadata: Record<string, unknown> }>} invoices */
export function classifyInvoiceRepair(invoices) {
  if (invoices.length !== NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS.length) {
    throw new Error("Northstar tenant does not have exactly five target receivable invoices");
  }
  const numbers = new Set(invoices.map((invoice) => invoice.invoice_number));
  if (
    numbers.size !== NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS.length ||
    NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS.some((invoiceNumber) => !numbers.has(invoiceNumber))
  ) {
    throw new Error("Northstar target receivable invoice set does not match the fixture");
  }
  const total = invoices.reduce((sum, invoice) => sum + Number(invoice.amount_due), 0).toFixed(8);
  if (total !== EXPECTED_AR_TOTAL) {
    throw new Error("Northstar target receivable invoice total does not match the fixture");
  }

  return invoices
    .filter((invoice) => invoice.metadata?.scenario !== "ar")
    .map((invoice) => {
      if (invoice.metadata?.scenario !== undefined) {
        throw new Error(
          `Northstar invoice ${invoice.invoice_number} has an unexpected scenario marker`,
        );
      }
      return invoice.id;
    });
}

/**
 * Identifies only the fixed Northstar transaction set that predates forward
 * categorization. This does not infer a category from free text: every
 * expected external transaction id has one fixture-defined canonical code.
 *
 * @param {Array<{ id: string, external_transaction_id: string, category_id: string | null, active_category_id: string | null, canonical_code: string | null }>} transactions
 */
export function classifyTransactionCategoryRepair(transactions) {
  const expected = new Map();
  for (const month of NORTHSTAR_MONTHS) {
    for (const [kind, canonicalCode] of Object.entries(NORTHSTAR_TRANSACTION_CATEGORY_BY_KIND)) {
      expected.set(`northstar:${month}:${kind}`, canonicalCode);
    }
  }

  if (transactions.length !== expected.size) {
    throw new Error("Northstar transaction set does not match the canonical fixture");
  }

  const seen = new Set();
  const repairs = [];
  for (const transaction of transactions) {
    const canonicalCode = expected.get(transaction.external_transaction_id);
    if (canonicalCode === undefined || seen.has(transaction.external_transaction_id)) {
      throw new Error("Northstar transaction set does not match the canonical fixture");
    }
    seen.add(transaction.external_transaction_id);

    if (transaction.canonical_code === null) {
      if (transaction.category_id !== null || transaction.active_category_id !== null) {
        throw new Error("Northstar transaction has an incomplete category assignment");
      }
      repairs.push({
        id: transaction.id,
        externalTransactionId: transaction.external_transaction_id,
        canonicalCode,
      });
      continue;
    }
    if (
      transaction.canonical_code !== canonicalCode ||
      transaction.category_id === null ||
      transaction.category_id !== transaction.active_category_id
    ) {
      throw new Error("Northstar transaction has an unexpected category assignment");
    }
  }
  if (seen.size !== expected.size) {
    throw new Error("Northstar transaction set does not match the canonical fixture");
  }
  return repairs;
}

/** @param {import("pg").PoolClient} client */
async function snapshot(client, lockRows) {
  const invoiceLock = lockRows ? " FOR UPDATE" : "";
  const policyLock = lockRows ? " FOR UPDATE" : "";
  const transactionLock = lockRows ? " FOR UPDATE OF t" : "";
  const invoiceResult = await client.query(
    `SELECT id, invoice_number, amount_due::text, metadata
       FROM ledger_invoices
      WHERE owner_id = $1 AND invoice_number = ANY($2::text[])
      ORDER BY invoice_number${invoiceLock}`,
    [NORTHSTAR_TENANT_ID, NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS],
  );
  const policyResult = await client.query(
    `SELECT id, version, state, content, content_hash, signers
       FROM policies
      WHERE tenant_id = $1 AND state = 'active'
      ORDER BY version DESC${policyLock}`,
    [NORTHSTAR_TENANT_ID],
  );
  const identityResult = await client.query(
    `SELECT m.id, m.email, m.role, m.active, m.status, l.surface
       FROM members m
       JOIN member_identity_links l
         ON l.tenant_id = m.tenant_id AND l.member_id = m.id
      WHERE m.tenant_id = $1 AND lower(m.email) = $2 AND l.surface = 'platform'`,
    [NORTHSTAR_TENANT_ID, NORTHSTAR_TEST_EMAIL],
  );
  const apResult = await client.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_due), 0)::text AS total,
            COUNT(*) FILTER (WHERE metadata->>'scenario' IS DISTINCT FROM 'ap')::int AS missing_markers
       FROM ledger_obligations
      WHERE owner_id = $1 AND direction = 'payable'`,
    [NORTHSTAR_TENANT_ID],
  );
  const cashResult = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'inflow' THEN amount ELSE -amount END), 0)::text AS annual_net,
            ROUND(COALESCE(SUM(CASE WHEN direction = 'inflow' THEN amount ELSE -amount END), 0) / 12, 2)::text AS monthly_average
       FROM ledger_transactions
      WHERE owner_id = $1 AND status = 'posted'`,
    [NORTHSTAR_TENANT_ID],
  );
  const transactionResult = await client.query(
    `SELECT t.id, t.external_transaction_id, t.category_id,
            assignment.category_id AS active_category_id, assignment.canonical_code
       FROM ledger_transactions t
       LEFT JOIN ledger_transaction_category_assignments assignment
         ON assignment.tenant_id = t.owner_id
        AND assignment.transaction_id = t.id
        AND assignment.superseded_at IS NULL
      WHERE t.owner_id = $1 AND t.external_transaction_id LIKE 'northstar:%'
      ORDER BY t.external_transaction_id${transactionLock}`,
    [NORTHSTAR_TENANT_ID],
  );

  if (policyResult.rows.length !== 1)
    throw new Error("Northstar tenant must have exactly one active policy");
  const policy = policyResult.rows[0];
  if (
    policy.version !== 2 ||
    policy.state !== "active" ||
    policy.content?.seed_key !== NORTHSTAR_SEED_KEY
  ) {
    throw new Error("Northstar active policy is outside the fixed remediation scope");
  }
  if (identityResult.rows.length !== 1) {
    throw new Error("Northstar presenter identity link is missing or not unique in core");
  }
  const identity = identityResult.rows[0];
  if (identity.role !== "admin" || identity.active !== true || identity.status !== "active") {
    throw new Error("Northstar presenter member is not an active admin");
  }

  return {
    invoices: invoiceResult.rows,
    policy,
    identity,
    ap: apResult.rows[0],
    cash: cashResult.rows[0],
    transactions: transactionResult.rows,
  };
}

/** @param {Awaited<ReturnType<typeof snapshot>>} value */
function report(value) {
  const policyRepair = repairPolicyContent(value.policy.content);
  const invoiceIds = classifyInvoiceRepair(value.invoices);
  const transactionCategoryRepairs = classifyTransactionCategoryRepair(value.transactions);
  const storedAutoRule = value.policy.content.rules.find(
    (rule) => rule.id === "northstar-ap-auto-approved",
  );
  const repairedAutoRule = policyRepair.content.rules.find(
    (rule) => rule.id === "northstar-ap-auto-approved",
  );
  return {
    tenant_id: NORTHSTAR_TENANT_ID,
    receivable_invoices: value.invoices.map((invoice) => ({
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      amount_due: invoice.amount_due,
      scenario: invoice.metadata?.scenario ?? null,
    })),
    invoice_rows_to_patch: invoiceIds.length,
    transaction_category_rows_to_patch: transactionCategoryRepairs.length,
    transaction_categories: value.transactions.map((transaction) => ({
      transaction_id: transaction.id,
      external_transaction_id: transaction.external_transaction_id,
      canonical_code: transaction.canonical_code,
    })),
    policy: {
      id: value.policy.id,
      version: value.policy.version,
      state: value.policy.state,
      has_signers: value.policy.signers !== null,
      list_rename_required: policyRepair.listRenamed,
      risk_bound_update_required: policyRepair.riskBoundUpdated,
      ach_autonomy_cap_add_required: policyRepair.achCapAdded,
      stored_auto_rule_list: storedAutoRule?.when?.["counterparty.in"],
      repaired_auto_rule_list: repairedAutoRule?.when?.["counterparty.in"],
      stored_auto_rule_risk_bound: storedAutoRule?.when?.["agent.risk_level.lte"],
      repaired_auto_rule_risk_bound: repairedAutoRule?.when?.["agent.risk_level.lte"],
      stored_auto_rule_ach_autonomy_cap: storedAutoRule?.ach_autonomous_max_amount ?? null,
      repaired_auto_rule_ach_autonomy_cap: repairedAutoRule?.ach_autonomous_max_amount ?? null,
    },
    core_presenter_identity: {
      email: value.identity.email,
      role: value.identity.role,
      active: value.identity.active,
      status: value.identity.status,
      platform_linked: value.identity.surface === "platform",
    },
    payables: value.ap,
    cash_flow: value.cash,
  };
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
  if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    if (!values.apply) {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [NORTHSTAR_TENANT_ID]);
      const before = await snapshot(client, false);
      process.stdout.write(`${JSON.stringify({ mode: "report", before: report(before) })}\n`);
      await client.query("ROLLBACK");
      return;
    }

    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [NORTHSTAR_TENANT_ID]);
    const before = await snapshot(client, true);
    const beforeReport = report(before);
    if (
      before.policy.signers !== null &&
      (beforeReport.policy.list_rename_required ||
        beforeReport.policy.risk_bound_update_required ||
        beforeReport.policy.ach_autonomy_cap_add_required)
    ) {
      throw new Error("refusing to alter a signed Northstar policy");
    }

    const invoiceIds = classifyInvoiceRepair(before.invoices);
    const transactionCategoryRepairs = classifyTransactionCategoryRepair(before.transactions);
    const repairedPolicy = repairPolicyContent(before.policy.content);
    let patchedInvoiceRows = 0;
    if (invoiceIds.length > 0) {
      const update = await client.query(
        `UPDATE ledger_invoices
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{scenario}', '"ar"'::jsonb, true)
          WHERE owner_id = $1 AND id = ANY($2::text[]) AND invoice_number = ANY($3::text[])
            AND metadata->>'scenario' IS DISTINCT FROM 'ar'
          RETURNING id`,
        [NORTHSTAR_TENANT_ID, invoiceIds, NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS],
      );
      if (update.rowCount !== invoiceIds.length) {
        throw new Error("Northstar invoice repair did not update exactly the preflight rows");
      }
      patchedInvoiceRows = update.rowCount;
    }

    let patchedPolicyRows = 0;
    if (repairedPolicy.changed) {
      const update = await client.query(
        `UPDATE policies
            SET content = $1::jsonb, content_hash = $2
          WHERE tenant_id = $3 AND id = $4 AND version = 2 AND state = 'active' AND content_hash = $5
          RETURNING id`,
        [
          JSON.stringify(repairedPolicy.content),
          contentHash(repairedPolicy.content),
          NORTHSTAR_TENANT_ID,
          before.policy.id,
          before.policy.content_hash,
        ],
      );
      if (update.rowCount !== 1)
        throw new Error("Northstar policy repair did not update exactly one active policy");
      patchedPolicyRows = update.rowCount;
    }
    await client.query("COMMIT");

    let patchedTransactionCategoryRows = 0;
    if (transactionCategoryRepairs.length > 0) {
      const { assignTransactionCategoryForTenant } = await import("@brain/ledger");
      const categoryAudit = new PostgresAuditEmitter(pool);
      for (const transaction of transactionCategoryRepairs) {
        const result = await assignTransactionCategoryForTenant(
          pool,
          categoryAudit,
          { tenantId: NORTHSTAR_TENANT_ID, actor: "ops:northstar-canonical-repair" },
          transaction.id,
          {
            canonicalCode: transaction.canonicalCode,
            method: "deterministic_rule",
            confidence: 1,
            ruleVersion: "northstar_demo_v1",
          },
        );
        if (!result.changed) {
          throw new Error("Northstar transaction category repair did not update a preflight row");
        }
        patchedTransactionCategoryRows += 1;
      }
    }

    const verifyClient = await pool.connect();
    let after;
    try {
      await verifyClient.query("BEGIN TRANSACTION READ ONLY");
      await verifyClient.query("SELECT set_config('app.tenant_id', $1, true)", [
        NORTHSTAR_TENANT_ID,
      ]);
      after = await snapshot(verifyClient, false);
      await verifyClient.query("ROLLBACK");
    } finally {
      verifyClient.release();
    }
    const afterReport = report(after);
    if (
      afterReport.invoice_rows_to_patch !== 0 ||
      afterReport.transaction_category_rows_to_patch !== 0 ||
      afterReport.policy.list_rename_required ||
      afterReport.policy.risk_bound_update_required ||
      afterReport.policy.ach_autonomy_cap_add_required
    ) {
      throw new Error("Northstar repair did not reach the expected postcondition");
    }

    let repairAuditId = null;
    if (patchedInvoiceRows > 0 || patchedPolicyRows > 0 || patchedTransactionCategoryRows > 0) {
      const audit = new PostgresAuditEmitter(pool);
      const repairEvent = await audit.emit({
        tenantId: NORTHSTAR_TENANT_ID,
        layer: "ledger",
        actor: "ops:northstar-canonical-repair",
        action: "northstar.seed.repaired",
        inputs: {
          invoice_numbers: NORTHSTAR_RECEIVABLE_INVOICE_NUMBERS,
          policy_id: before.policy.id,
        },
        outputs: {
          invoice_metadata_rows_patched: patchedInvoiceRows,
          transaction_category_rows_patched: patchedTransactionCategoryRows,
          policy_list_renamed: patchedPolicyRows === 1,
          policy_risk_bound_updated: beforeReport.policy.risk_bound_update_required,
          policy_ach_autonomy_cap_added: beforeReport.policy.ach_autonomy_cap_add_required,
          policy_version: 2,
        },
        idempotencyKey: REPAIR_IDEMPOTENCY_KEY,
      });
      repairAuditId = repairEvent.id;
    }
    process.stdout.write(
      `${JSON.stringify({
        mode: "apply",
        patched_invoice_rows: patchedInvoiceRows,
        patched_policy_rows: patchedPolicyRows,
        repair_audit_event_id: repairAuditId,
        before: beforeReport,
        after: afterReport,
      })}\n`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
