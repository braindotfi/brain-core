import { Pool } from "pg";

const tenantId = process.env.BRAIN_TENANT_ID;
if (tenantId === undefined || !/^tnt_[0-9A-HJKMNP-TV-Z]{26}$/.test(tenantId)) {
  throw new Error("BRAIN_TENANT_ID must be a canonical tenant id");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN TRANSACTION READ ONLY");
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  const accounts = await client.query(
    `SELECT COUNT(*)::int AS count FROM ledger_accounts WHERE owner_id = $1`,
    [tenantId],
  );
  const payables = await client.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_due), 0)::text AS total FROM ledger_obligations WHERE owner_id = $1 AND direction = 'payable' AND status = 'upcoming'`,
    [tenantId],
  );
  const receivables = await client.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_due), 0)::text AS total, COALESCE(SUM(amount_due) FILTER (WHERE status = 'overdue'), 0)::text AS overdue_total FROM ledger_invoices WHERE owner_id = $1 AND status IN ('sent', 'overdue')`,
    [tenantId],
  );
  const cashFlow = await client.query(
    `SELECT COUNT(DISTINCT date_trunc('month', transaction_date))::int AS months, COALESCE(SUM(CASE WHEN direction = 'inflow' THEN amount ELSE -amount END), 0)::text AS annual_net, ROUND(COALESCE(SUM(CASE WHEN direction = 'inflow' THEN amount ELSE -amount END), 0) / 12, 2)::text AS monthly_average, COALESCE(SUM(CASE WHEN transaction_date >= '2026-08-01T00:00:00Z'::timestamptz AND direction = 'inflow' THEN amount ELSE 0 END) - SUM(CASE WHEN transaction_date >= '2026-08-01T00:00:00Z'::timestamptz AND direction = 'outflow' THEN amount ELSE 0 END), 0)::text AS august_net FROM ledger_transactions WHERE owner_id = $1 AND status = 'posted'`,
    [tenantId],
  );
  const counterparties = await client.query(
    `SELECT COUNT(*)::int AS count FROM ledger_counterparties WHERE owner_id = $1`,
    [tenantId],
  );
  const inbox = await client.query(
    `SELECT p.id, p.created_at, p.action->>'invoice_id' AS invoice_id, i.invoice_number, p.action->>'counterparty_id' AS counterparty_id, c.name AS counterparty_name, p.action->'evidence_refs' AS evidence_refs
       FROM proposals p
       LEFT JOIN ledger_invoices i ON i.id = p.action->>'invoice_id' AND i.owner_id = p.tenant_id
       LEFT JOIN ledger_counterparties c ON c.id = p.action->>'counterparty_id' AND c.owner_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.status = 'pending' AND p.action->>'type' = 'collections'
      ORDER BY p.created_at, p.id`,
    [tenantId],
  );
  const policy = await client.query(
    `SELECT version, state, content->'lists'->'vendors.approved' AS approved_vendors FROM policies WHERE tenant_id = $1 AND state = 'active' ORDER BY version DESC LIMIT 1`,
    [tenantId],
  );
  const audit = await client.query(
    `SELECT action, COUNT(*)::int AS count FROM audit_events WHERE tenant_id = $1 AND action IN ('ledger.account.created', 'ledger.counterparty.created', 'ledger.transaction.posted', 'ledger.obligation.created', 'policy.activated', 'agent.action.proposed') GROUP BY action ORDER BY action`,
    [tenantId],
  );

  const result = {
    tenant_id: tenantId,
    overview: {
      accounts: accounts.rows[0]?.count ?? 0,
      annual_net: cashFlow.rows[0]?.annual_net,
      monthly_average: cashFlow.rows[0]?.monthly_average,
      months: cashFlow.rows[0]?.months ?? 0,
      august_net: cashFlow.rows[0]?.august_net,
    },
    payables: payables.rows[0],
    receivables: receivables.rows[0],
    counterparties: counterparties.rows[0],
    inbox: { count: inbox.rows.length, proposals: inbox.rows },
    policy: policy.rows[0] ?? null,
    audit: audit.rows,
  };
  const expected =
    result.overview.annual_net === "1300000.00000000" &&
    result.overview.monthly_average === "108333.33" &&
    result.overview.months === 12 &&
    result.overview.august_net === "162000.00000000" &&
    result.payables?.count === 7 &&
    result.payables.total === "221300.00000000" &&
    result.receivables?.count === 5 &&
    result.receivables.total === "530500.00000000" &&
    result.receivables.overdue_total === "280000.00000000" &&
    result.counterparties?.count === 12 &&
    result.inbox.count === 2 &&
    result.inbox.proposals.every(
      (proposal) =>
        proposal.invoice_id?.startsWith("inv_") &&
        proposal.invoice_number !== null &&
        proposal.counterparty_name !== null &&
        Array.isArray(proposal.evidence_refs) &&
        proposal.evidence_refs.some(
          (evidence) => evidence.kind === "invoice" && evidence.ref === proposal.invoice_id,
        ) &&
        proposal.evidence_refs.some(
          (evidence) =>
            evidence.kind === "counterparty" && evidence.ref === proposal.counterparty_id,
        ),
    ) &&
    result.policy?.state === "active" &&
    result.policy?.version === 2 &&
    result.audit.some((row) => row.action === "policy.activated") &&
    result.audit.some((row) => row.action === "agent.action.proposed");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!expected) process.exitCode = 1;
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
