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
  const [accounts, payables, receivables, cashFlow, counterparties, inbox, policy, audit] =
    await Promise.all([
      client.query(`SELECT COUNT(*)::int AS count FROM ledger_accounts WHERE owner_id = $1`, [
        tenantId,
      ]),
      client.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_due), 0)::text AS total FROM ledger_obligations WHERE owner_id = $1 AND direction = 'payable' AND status = 'upcoming'`,
        [tenantId],
      ),
      client.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_due), 0)::text AS total, COALESCE(SUM(amount_due) FILTER (WHERE status = 'overdue'), 0)::text AS overdue_total FROM ledger_invoices WHERE owner_id = $1 AND status IN ('sent', 'overdue')`,
        [tenantId],
      ),
      client.query(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'inflow' THEN amount ELSE -amount END), 0)::text AS annual_net, COALESCE(SUM(CASE WHEN transaction_date >= '2026-08-01T00:00:00Z'::timestamptz AND direction = 'inflow' THEN amount ELSE 0 END) - SUM(CASE WHEN transaction_date >= '2026-08-01T00:00:00Z'::timestamptz AND direction = 'outflow' THEN amount ELSE 0 END), 0)::text AS august_net FROM ledger_transactions WHERE owner_id = $1 AND status = 'posted'`,
        [tenantId],
      ),
      client.query(`SELECT COUNT(*)::int AS count FROM ledger_counterparties WHERE owner_id = $1`, [
        tenantId,
      ]),
      client.query(
        `SELECT COUNT(*)::int AS count FROM proposals WHERE tenant_id = $1 AND status = 'pending' AND action->>'type' = 'collections'`,
        [tenantId],
      ),
      client.query(
        `SELECT version, state, content->'lists'->'vendors.approved' AS approved_vendors FROM policies WHERE tenant_id = $1 AND state = 'active' ORDER BY version DESC LIMIT 1`,
        [tenantId],
      ),
      client.query(
        `SELECT action, COUNT(*)::int AS count FROM audit_events WHERE tenant_id = $1 AND action IN ('ledger.account.created', 'ledger.counterparty.created', 'ledger.transaction.posted', 'ledger.obligation.created', 'policy.activated', 'agent.action.proposed') GROUP BY action ORDER BY action`,
        [tenantId],
      ),
    ]);

  const result = {
    tenant_id: tenantId,
    overview: {
      accounts: accounts.rows[0]?.count ?? 0,
      annual_net: cashFlow.rows[0]?.annual_net,
      monthly_average: "108333.33",
      august_net: cashFlow.rows[0]?.august_net,
    },
    payables: payables.rows[0],
    receivables: receivables.rows[0],
    counterparties: counterparties.rows[0],
    inbox: inbox.rows[0],
    policy: policy.rows[0] ?? null,
    audit: audit.rows,
  };
  const expected =
    result.overview.annual_net === "1300000.00000000" &&
    result.overview.august_net === "162000.00000000" &&
    result.payables?.count === 7 &&
    result.payables.total === "221300.00000000" &&
    result.receivables?.count === 5 &&
    result.receivables.total === "530500.00000000" &&
    result.receivables.overdue_total === "280000.00000000" &&
    result.counterparties?.count === 12 &&
    result.inbox?.count === 2 &&
    result.policy?.state === "active" &&
    result.audit.some((row) => row.action === "policy.activated") &&
    result.audit.some((row) => row.action === "agent.action.proposed");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!expected) process.exitCode = 1;
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
