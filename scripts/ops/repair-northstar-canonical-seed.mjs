/**
 * Repairs the pre-#680 Northstar staging tenant in place.
 *
 * The purpose-built Northstar seeder rejects nonempty tenants before writing,
 * so re-running it cannot repair the original presenter tenant. This script
 * has one fixed tenant and no free-form identifiers. It patches only the five
 * receivable invoice metadata documents and the unsigned active Northstar
 * policy's list key, then records one idempotent repair audit event.
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
const REPAIR_IDEMPOTENCY_KEY = "northstar_labs_v1:canonical-repair:v1";

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

  if (
    !Array.isArray(lists["vendors.policy_allowlisted"]) ||
    lists["vendors.policy_allowlisted"].length !== 5 ||
    autoRule.when["counterparty.in"] !== "vendors.policy_allowlisted"
  ) {
    throw new Error("Northstar repaired policy does not have the expected allowlist");
  }

  return {
    content: next,
    changed: legacyList !== undefined,
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

/** @param {import("pg").PoolClient} client */
async function snapshot(client, lockRows) {
  const invoiceLock = lockRows ? " FOR UPDATE" : "";
  const policyLock = lockRows ? " FOR UPDATE" : "";
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
  };
}

/** @param {Awaited<ReturnType<typeof snapshot>>} value */
function report(value) {
  const policyRepair = repairPolicyContent(value.policy.content);
  const invoiceIds = classifyInvoiceRepair(value.invoices);
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
    policy: {
      id: value.policy.id,
      version: value.policy.version,
      state: value.policy.state,
      has_signers: value.policy.signers !== null,
      list_rename_required: policyRepair.changed,
      stored_auto_rule_list: storedAutoRule?.when?.["counterparty.in"],
      repaired_auto_rule_list: repairedAutoRule?.when?.["counterparty.in"],
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
    if (before.policy.signers !== null && beforeReport.policy.list_rename_required) {
      throw new Error("refusing to alter a signed Northstar policy");
    }

    const invoiceIds = classifyInvoiceRepair(before.invoices);
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
    if (afterReport.invoice_rows_to_patch !== 0 || afterReport.policy.list_rename_required) {
      throw new Error("Northstar repair did not reach the expected postcondition");
    }

    let repairAuditId = null;
    if (patchedInvoiceRows > 0 || patchedPolicyRows > 0) {
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
          policy_list_renamed: patchedPolicyRows === 1,
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
