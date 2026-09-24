import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  brainError,
  isBrainId,
  newCounterpartyId,
  requireScope,
  withTenantScope,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";
import { internalAgentDefinitions } from "@brain/internal-agents";

const SCOPE_READ: Scope = "execution:read";
const SCOPE_ADMIN: Scope = "execution:admin";
const SCOPE_LEDGER_READ: Scope = "ledger:read";
const SCOPE_LEDGER_WRITE: Scope = "ledger:write";
const SCOPE_PAYMENT_PROPOSE: Scope = "payment_intent:propose";

const ROBOTMONEY_AGENT_KEYS = [
  "fraud_anomaly",
  "vendor_risk",
  "dispute",
  "aml_compliance",
  "payment",
  "collections",
  "treasury",
  "subscription_management",
  "invoice_integrity",
  "reconciliation",
  "cash_forecast",
  "revenue_intel",
] as const;

type TwoFactorMethod = "authenticator" | "sms" | "backup_codes";

export interface RobotMoneyUiRoutesDeps {
  pool: Pool;
}

interface AccountRow {
  id: string;
  account_type: string;
  name: string;
  institution: string | null;
  current_balance: string | number | null;
  available_balance: string | number | null;
  currency: string;
  updated_at: Date | string | null;
}

interface AccountTrendRow {
  account_id: string;
  delta_amount: string | number | null;
  flagged_count: string | number | null;
  sparkline: Array<string | number | null> | string | null;
}

interface SavingsYieldRow {
  account_id: string;
  ytd_yield: string | number | null;
}

interface TenantMoneySettingsRow {
  operating_account_id: string | null;
  net_burn_per_day: string | number | null;
}

interface TrustedDeviceRow {
  id: string;
  label: string | null;
  last_used_at: Date | string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface AgentRuleRow {
  agent: string;
  id: string;
  decision: string;
  authority: string;
  condition: unknown;
}

interface AgentOverrideRow {
  agent: string;
  per_user_overrides_count: string | number;
}

interface AgentProposalStatsRow {
  agent: string;
  weekly_decision_count: string | number;
  weekly_auto_count: string | number;
  weekly_needed_you_count: string | number;
  last_activity_at: Date | string | null;
}

interface AgentAuditRow {
  action: string;
  last_activity_at: Date | string | null;
}

interface AccountTransactionRow {
  id: string;
  amount: string | number;
  currency: string;
  direction: string;
  transaction_date: Date | string | null;
  posted_date: Date | string | null;
  counterparty_id: string | null;
  status: string;
  description_raw: string | null;
  description_normalized: string | null;
}

interface SearchProposalRow {
  id: string;
  proposing_agent: string | null;
  status: string;
  action: { title?: string; headline?: string } | null;
  created_at: Date | string | null;
}

function assertCtx(request: FastifyRequest): ServiceCallContext {
  if (request.principal === undefined) {
    throw brainError("auth_token_missing", "principal required");
  }
  return {
    tenantId: request.principal.tenantId,
    actor: request.principal.id,
    requestId: request.id,
    principalType: request.principal.type,
    scopes: request.principal.scopes,
  };
}

function asIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalTextArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : null;
}

function optionalAccountant(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw brainError("request_body_invalid", "accountant must be an object");
  }
  const row = value as Record<string, unknown>;
  const name = optionalText(row.name);
  const org = optionalText(row.org);
  const email = optionalText(row.email);
  if (name === null || org === null || email === null) {
    throw brainError("request_body_invalid", "accountant requires name, org, and email");
  }
  return { name, org, email };
}

function optionalMoneyAmount(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value.toFixed(2);
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) return value;
  throw brainError("request_body_invalid", "money amount must be a non-negative number");
}

function requireUserPrincipal(request: FastifyRequest): string {
  if (request.principal?.type !== "user") {
    throw brainError("auth_forbidden", "user principal required", { statusOverride: 403 });
  }
  return request.principal.id;
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d+)?$/.test(value) && value !== "0";
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateBackupCodes(): string[] {
  return Array.from({ length: 8 }, () => randomUUID().replace(/-/g, "").slice(0, 10));
}

function quoteRate(source: string, destination: string): string {
  const rates: Record<string, string> = {
    "USD:USDC": "1.000000000000",
    "USDC:USD": "1.000000000000",
    "USD:ETH": "0.000300000000",
    "ETH:USD": "3333.333333333333",
  };
  return rates[`${source}:${destination}`] ?? "1.000000000000";
}

function uiAccountType(accountType: string): "checking" | "savings" | "card" | "wallet" {
  if (accountType === "bank_savings") return "savings";
  if (accountType === "card") return "card";
  if (accountType === "onchain") return "wallet";
  return "checking";
}

function amountNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function directionFor(delta: number): "up" | "down" | "flat" {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

function moneyDelta(delta: number, currency: string): string {
  if (delta === 0) return "";
  const sign = delta > 0 ? "+" : "-";
  const abs = Math.abs(delta);
  const symbol = currency === "USD" ? "$" : `${currency} `;
  if (abs >= 10000) return `${sign}${symbol}${Math.round(abs / 1000)}K`;
  return `${sign}${symbol}${Math.round(abs).toLocaleString("en-US")}`;
}

function parseSparkline(value: Array<string | number | null> | string | null): number[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => amountNumber(item));
}

function trendFromDelta(
  delta: number,
  currency: string,
  window: string,
  sparkline: number[],
  note: string,
) {
  return {
    delta_amount: delta,
    delta_display: moneyDelta(delta, currency),
    direction: directionFor(delta),
    window,
    sparkline,
    note,
  };
}

function headroomDisplay(amount: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const formatted = Math.abs(Math.round(amount)).toLocaleString("en-US");
  return amount < 0 ? `${symbol}${formatted} short` : `${symbol}${formatted} above`;
}

function accountNote(
  type: ReturnType<typeof uiAccountType>,
  currency: string,
  trend?: AccountTrendRow,
  ytdYield?: number,
): string {
  if (type === "wallet") return "gas reserve";
  if (type === "savings" && ytdYield !== undefined && ytdYield > 0) {
    return `earning ${moneyDelta(ytdYield, currency).replace(/^\+/, "")}/yr`;
  }
  const flagged = amountNumber(trend?.flagged_count);
  return flagged > 0 ? `${flagged} flagged` : "";
}

async function decorateAccounts(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
  accountRows: AccountRow[],
) {
  if (accountRows.length === 0) return [];
  const [settingsResult, trendResult, savingsResult] = await Promise.all([
    client.query(
      `SELECT operating_account_id, net_burn_per_day
         FROM tenant_profiles
        WHERE tenant_id = $1
        LIMIT 1`,
      [tenantId],
    ),
    client.query(
      `WITH account_scope AS (
         SELECT unnest($2::text[]) AS account_id
       ),
       daily AS (
         SELECT s.account_id,
                day::date AS day,
                COALESCE(round(sum(
                  CASE
                    WHEN t.direction = 'inflow' THEN t.amount
                    WHEN t.direction = 'outflow' THEN -t.amount
                    ELSE 0
                  END
                ), 2), 0) AS net_amount
           FROM account_scope s
           CROSS JOIN generate_series((current_date - interval '6 day')::date, current_date, interval '1 day') day
           LEFT JOIN ledger_transactions t
             ON t.owner_id = $1
            AND t.account_id = s.account_id
            AND t.transaction_date >= day
            AND t.transaction_date < day + interval '1 day'
            AND t.status IN ('posted', 'cleared', 'disputed')
          GROUP BY s.account_id, day
       ),
       flagged AS (
         SELECT account_id, count(*)::int AS flagged_count
           FROM ledger_transactions
          WHERE owner_id = $1
            AND account_id = ANY($2::text[])
            AND transaction_date >= now() - interval '7 days'
            AND status IN ('disputed', 'failed')
          GROUP BY account_id
       )
       SELECT daily.account_id,
              round(sum(daily.net_amount), 2) AS delta_amount,
              COALESCE(flagged.flagged_count, 0) AS flagged_count,
              json_agg(daily.net_amount ORDER BY daily.day) AS sparkline
         FROM daily
         LEFT JOIN flagged ON flagged.account_id = daily.account_id
        GROUP BY daily.account_id, flagged.flagged_count`,
      [tenantId, accountRows.map((row) => row.id)],
    ),
    client.query(
      `SELECT account_id, round(sum(amount), 2) AS ytd_yield
         FROM ledger_transactions
        WHERE owner_id = $1
          AND account_id = ANY($2::text[])
          AND direction = 'inflow'
          AND transaction_date >= date_trunc('year', now())
          AND status IN ('posted', 'cleared')
          AND (
            description_normalized ILIKE '%interest%'
            OR description_normalized ILIKE '%yield%'
            OR description_raw ILIKE '%interest%'
            OR description_raw ILIKE '%yield%'
          )
        GROUP BY account_id`,
      [tenantId, accountRows.map((row) => row.id)],
    ),
  ]);
  const settings = (settingsResult.rows[0] ?? {}) as TenantMoneySettingsRow;
  const trends = new Map(
    (trendResult.rows as AccountTrendRow[]).map((row) => [row.account_id, row]),
  );
  const yields = new Map(
    (savingsResult.rows as SavingsYieldRow[]).map((row) => [
      row.account_id,
      amountNumber(row.ytd_yield),
    ]),
  );
  const burn = amountNumber(settings.net_burn_per_day);
  return accountRows.map((row) => {
    const type = uiAccountType(row.account_type);
    const trend = trends.get(row.id);
    const balance = row.available_balance ?? row.current_balance;
    const numericBalance = amountNumber(balance);
    const ytdYield = yields.get(row.id);
    const delta = type === "savings" ? (ytdYield ?? 0) : amountNumber(trend?.delta_amount);
    const window = type === "savings" ? "this year" : "this week";
    const sparkline =
      type === "savings" || type === "wallet" ? [] : parseSparkline(trend?.sparkline ?? null);
    const floor = Number((90 * burn).toFixed(2));
    const headroom = Number((numericBalance - floor).toFixed(2));
    const safetyFloor =
      settings.operating_account_id === row.id && burn > 0
        ? {
            label: "90-day burn floor",
            current_amount: numericBalance,
            floor_amount: floor,
            headroom_amount: headroom,
            headroom_display: headroomDisplay(headroom, row.currency),
            state: numericBalance > floor ? "above" : numericBalance < floor ? "below" : "at",
          }
        : null;
    return {
      id: row.id,
      type,
      name: row.name,
      institution: row.institution,
      balance,
      currency: row.currency,
      last_sync: asIso(row.updated_at),
      trend: trendFromDelta(
        delta,
        row.currency,
        window,
        sparkline,
        accountNote(type, row.currency, trend, ytdYield),
      ),
      safety_floor: safetyFloor,
    };
  });
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export async function registerRobotMoneyUiRoutes(
  app: FastifyInstance,
  deps: RobotMoneyUiRoutesDeps,
): Promise<void> {
  app.get("/tenant/profile", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);
    const profile = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT tenant_id, legal_name, dba_name, address_line1, address_line2,
                city, state, postal_code, country, tax_id, industry, jurisdiction,
                fiscal_year_end, accountant, operating_account_id, net_burn_per_day, updated_at
           FROM tenant_profiles
          WHERE tenant_id = $1
          LIMIT 1`,
        [ctx.tenantId],
      );
      return rows[0] ?? { tenant_id: ctx.tenantId };
    });
    reply.status(200);
    return profile;
  });

  app.patch(
    "/tenant/profile",
    async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_ADMIN);
      const b = request.body ?? {};
      const values = [
        ctx.tenantId,
        optionalText(b.legal_name),
        optionalText(b.dba_name),
        optionalText(b.address_line1),
        optionalText(b.address_line2),
        optionalText(b.city),
        optionalText(b.state),
        optionalText(b.postal_code),
        optionalText(b.country),
        optionalText(b.tax_id ?? b.ein),
        optionalText(b.industry),
        optionalText(b.jurisdiction),
        optionalText(b.fiscal_year_end),
        b.accountant === undefined ? null : JSON.stringify(optionalAccountant(b.accountant)),
        optionalText(b.operating_account_id),
        optionalMoneyAmount(b.net_burn_per_day),
      ];
      const row = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO tenant_profiles (
             tenant_id, legal_name, dba_name, address_line1, address_line2,
             city, state, postal_code, country, tax_id, industry, jurisdiction,
             fiscal_year_end, accountant, operating_account_id, net_burn_per_day
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::numeric)
           ON CONFLICT (tenant_id) DO UPDATE SET
             legal_name = COALESCE(EXCLUDED.legal_name, tenant_profiles.legal_name),
             dba_name = COALESCE(EXCLUDED.dba_name, tenant_profiles.dba_name),
             address_line1 = COALESCE(EXCLUDED.address_line1, tenant_profiles.address_line1),
             address_line2 = COALESCE(EXCLUDED.address_line2, tenant_profiles.address_line2),
             city = COALESCE(EXCLUDED.city, tenant_profiles.city),
             state = COALESCE(EXCLUDED.state, tenant_profiles.state),
             postal_code = COALESCE(EXCLUDED.postal_code, tenant_profiles.postal_code),
             country = COALESCE(EXCLUDED.country, tenant_profiles.country),
             tax_id = COALESCE(EXCLUDED.tax_id, tenant_profiles.tax_id),
             industry = COALESCE(EXCLUDED.industry, tenant_profiles.industry),
             jurisdiction = COALESCE(EXCLUDED.jurisdiction, tenant_profiles.jurisdiction),
             fiscal_year_end = COALESCE(EXCLUDED.fiscal_year_end, tenant_profiles.fiscal_year_end),
             accountant = COALESCE(EXCLUDED.accountant, tenant_profiles.accountant),
             operating_account_id = COALESCE(EXCLUDED.operating_account_id, tenant_profiles.operating_account_id),
             net_burn_per_day = COALESCE(EXCLUDED.net_burn_per_day, tenant_profiles.net_burn_per_day),
             updated_at = now()
           RETURNING *`,
          values,
        );
        return rows[0];
      });
      reply.status(200);
      return row;
    },
  );

  app.get("/settings/notifications", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);
    const prefs = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO tenant_notification_preferences (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
         RETURNING *`,
        [ctx.tenantId],
      );
      return rows[0];
    });
    reply.status(200);
    return prefs;
  });

  app.patch(
    "/settings/notifications",
    async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_ADMIN);
      const b = request.body ?? {};
      const channels = optionalTextArray(b.proactive_alert_channels);
      const muteList = optionalTextArray(b.agent_mute_list);
      const prefs = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO tenant_notification_preferences (
             tenant_id, proactive_briefs_enabled, proactive_alerts_enabled,
             proactive_alert_channels, quiet_hours, agent_mute_list
           )
           VALUES ($1,$2,$3,COALESCE($4::TEXT[], ARRAY['email']::TEXT[]),$5::jsonb,
             COALESCE($6::TEXT[], ARRAY[]::TEXT[]))
           ON CONFLICT (tenant_id) DO UPDATE SET
             proactive_briefs_enabled = COALESCE(EXCLUDED.proactive_briefs_enabled,
               tenant_notification_preferences.proactive_briefs_enabled),
             proactive_alerts_enabled = COALESCE(EXCLUDED.proactive_alerts_enabled,
               tenant_notification_preferences.proactive_alerts_enabled),
             proactive_alert_channels = COALESCE(EXCLUDED.proactive_alert_channels,
               tenant_notification_preferences.proactive_alert_channels),
             quiet_hours = COALESCE(EXCLUDED.quiet_hours,
               tenant_notification_preferences.quiet_hours),
             agent_mute_list = COALESCE(EXCLUDED.agent_mute_list,
               tenant_notification_preferences.agent_mute_list),
             updated_at = now()
           RETURNING *`,
          [
            ctx.tenantId,
            typeof b.proactive_briefs_enabled === "boolean" ? b.proactive_briefs_enabled : null,
            typeof b.proactive_alerts_enabled === "boolean" ? b.proactive_alerts_enabled : null,
            channels,
            b.quiet_hours === undefined ? null : JSON.stringify(b.quiet_hours),
            muteList,
          ],
        );
        return rows[0];
      });
      reply.status(200);
      return prefs;
    },
  );

  app.get("/tenant/notification-preferences", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);
    const prefs = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO tenant_notification_preferences (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
         RETURNING *`,
        [ctx.tenantId],
      );
      return rows[0];
    });
    reply.status(200);
    return prefs;
  });

  app.patch(
    "/tenant/notification-preferences",
    async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_ADMIN);
      const b = request.body ?? {};
      const channels = optionalTextArray(b.proactive_alert_channels);
      const muteList = optionalTextArray(b.agent_mute_list);
      const prefs = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO tenant_notification_preferences (
             tenant_id, proactive_briefs_enabled, proactive_alerts_enabled,
             proactive_alert_channels, quiet_hours, agent_mute_list
           )
           VALUES ($1,$2,$3,COALESCE($4::TEXT[], ARRAY['email']::TEXT[]),$5::jsonb,
             COALESCE($6::TEXT[], ARRAY[]::TEXT[]))
           ON CONFLICT (tenant_id) DO UPDATE SET
             proactive_briefs_enabled = COALESCE(EXCLUDED.proactive_briefs_enabled,
               tenant_notification_preferences.proactive_briefs_enabled),
             proactive_alerts_enabled = COALESCE(EXCLUDED.proactive_alerts_enabled,
               tenant_notification_preferences.proactive_alerts_enabled),
             proactive_alert_channels = COALESCE(EXCLUDED.proactive_alert_channels,
               tenant_notification_preferences.proactive_alert_channels),
             quiet_hours = COALESCE(EXCLUDED.quiet_hours,
               tenant_notification_preferences.quiet_hours),
             agent_mute_list = COALESCE(EXCLUDED.agent_mute_list,
               tenant_notification_preferences.agent_mute_list),
             updated_at = now()
           RETURNING *`,
          [
            ctx.tenantId,
            typeof b.proactive_briefs_enabled === "boolean" ? b.proactive_briefs_enabled : null,
            typeof b.proactive_alerts_enabled === "boolean" ? b.proactive_alerts_enabled : null,
            channels,
            b.quiet_hours === undefined ? null : JSON.stringify(b.quiet_hours),
            muteList,
          ],
        );
        return rows[0];
      });
      reply.status(200);
      return prefs;
    },
  );

  app.get("/auth/two-factor", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);
    const userId = requireUserPrincipal(request);
    const rows = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const result = await client.query(
        `SELECT method, status, phone_number, created_at, updated_at
           FROM user_two_factor_methods
          WHERE tenant_id = $1 AND user_id = $2
          ORDER BY method`,
        [ctx.tenantId, userId],
      );
      return result.rows;
    });
    reply.status(200);
    return {
      enabled: rows.some((row) => row.status === "enabled"),
      methods: rows.filter((row) => row.status === "enabled").map((row) => row.method),
      method_details: rows,
    };
  });

  app.post(
    "/auth/two-factor/enroll",
    async (
      request: FastifyRequest<{ Body: { method?: TwoFactorMethod; phone_number?: string } }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_ADMIN);
      const userId = requireUserPrincipal(request);
      const method = request.body?.method;
      if (method !== "authenticator" && method !== "sms" && method !== "backup_codes") {
        throw brainError(
          "request_body_invalid",
          "method must be authenticator, sms, or backup_codes",
        );
      }
      const secretRef = randomUUID();
      const backupCodes = method === "backup_codes" ? generateBackupCodes() : [];
      await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        await client.query(
          `INSERT INTO user_two_factor_methods (
             tenant_id, user_id, method, status, secret_ref, phone_number, backup_codes_hashes
           )
           VALUES ($1,$2,$3,'pending',$4,$5,$6)
           ON CONFLICT (tenant_id, user_id, method) DO UPDATE SET
             status = 'pending',
             secret_ref = EXCLUDED.secret_ref,
             phone_number = EXCLUDED.phone_number,
             backup_codes_hashes = EXCLUDED.backup_codes_hashes,
             updated_at = now()`,
          [
            ctx.tenantId,
            userId,
            method,
            secretRef,
            request.body?.phone_number ?? null,
            backupCodes.map(hashValue),
          ],
        );
      });
      reply.status(201);
      return {
        method,
        status: "pending",
        enrollment_id: secretRef,
        ...(method === "authenticator"
          ? { qr_uri: `otpauth://totp/RobotMoney:${userId}?secret=${secretRef}` }
          : {}),
        ...(method === "backup_codes" ? { backup_codes: backupCodes } : {}),
      };
    },
  );

  app.post(
    "/auth/two-factor/confirm-enrollment",
    async (
      request: FastifyRequest<{ Body: { method?: TwoFactorMethod; code?: string } }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_ADMIN);
      const userId = requireUserPrincipal(request);
      const method = request.body?.method;
      if (method !== "authenticator" && method !== "sms" && method !== "backup_codes") {
        throw brainError(
          "request_body_invalid",
          "method must be authenticator, sms, or backup_codes",
        );
      }
      if (typeof request.body?.code !== "string" || request.body.code.length === 0) {
        throw brainError("request_body_invalid", "code is required");
      }
      const row = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const result = await client.query(
          `UPDATE user_two_factor_methods
              SET status = 'enabled', updated_at = now()
            WHERE tenant_id = $1 AND user_id = $2 AND method = $3 AND status = 'pending'
            RETURNING method, status, phone_number, created_at, updated_at`,
          [ctx.tenantId, userId, method],
        );
        return result.rows[0] ?? null;
      });
      if (row === null) throw brainError("two_factor_method_not_found", "no pending method");
      reply.status(200);
      return row;
    },
  );

  app.delete(
    "/auth/two-factor/:method",
    async (
      request: FastifyRequest<{
        Params: { method: string };
        Body: { current_password?: string; backup_code?: string };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_ADMIN);
      const userId = requireUserPrincipal(request);
      if (request.body?.current_password === undefined && request.body?.backup_code === undefined) {
        throw brainError("request_body_invalid", "current_password or backup_code is required");
      }
      await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        await client.query(
          `DELETE FROM user_two_factor_methods
            WHERE tenant_id = $1 AND user_id = $2 AND method = $3`,
          [ctx.tenantId, userId, request.params.method],
        );
      });
      reply.status(204);
      return null;
    },
  );

  app.get("/auth/trusted-devices", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);
    const userId = requireUserPrincipal(request);
    const rows = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const result = await client.query<TrustedDeviceRow>(
        `SELECT id, label, last_used_at, ip, user_agent, created_at, updated_at
           FROM trusted_devices
          WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL
          ORDER BY COALESCE(last_used_at, created_at) DESC`,
        [ctx.tenantId, userId],
      );
      return result.rows.map((row) => ({ ...row, last_used_at: asIso(row.last_used_at) }));
    });
    reply.status(200);
    return { devices: rows };
  });

  app.delete(
    "/auth/trusted-devices/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_ADMIN);
      const userId = requireUserPrincipal(request);
      await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        await client.query(
          `UPDATE trusted_devices
              SET revoked_at = now(), updated_at = now()
            WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
          [ctx.tenantId, userId, request.params.id],
        );
      });
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/exchange/quote",
    async (
      request: FastifyRequest<{
        Body: { source_currency?: string; destination_currency?: string; amount?: string };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_PAYMENT_PROPOSE);
      const b = request.body ?? {};
      if (
        b.source_currency === undefined ||
        !/^[A-Z0-9]{3,6}$/.test(b.source_currency) ||
        b.destination_currency === undefined ||
        !/^[A-Z0-9]{3,6}$/.test(b.destination_currency) ||
        !isPositiveDecimal(b.amount)
      ) {
        throw brainError(
          "request_body_invalid",
          "source_currency, destination_currency, and amount are required",
        );
      }
      const quoteId = randomUUID();
      const rate = quoteRate(b.source_currency, b.destination_currency);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        await client.query(
          `INSERT INTO exchange_quotes (
             id, tenant_id, source_currency, destination_currency, amount,
             rate, fee_cents, expires_at, created_by
           )
           VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)`,
          [
            quoteId,
            ctx.tenantId,
            b.source_currency,
            b.destination_currency,
            b.amount,
            rate,
            expiresAt,
            ctx.actor,
          ],
        );
      });
      reply.status(201);
      return {
        quote_id: quoteId,
        rate_lock_reference: quoteId,
        source_currency: b.source_currency,
        destination_currency: b.destination_currency,
        amount: b.amount,
        rate,
        fee_cents: 0,
        expires_at: expiresAt,
      };
    },
  );

  app.get("/agents/overview", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_READ);
    const rows = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const [rulesResult, overridesResult, proposalResult, auditResult] = await Promise.all([
        client.query<AgentRuleRow>(
          `SELECT agent, id, decision, authority, condition
             FROM agent_authority_rules
            WHERE tenant_id = $1 AND enabled = TRUE AND deleted_at IS NULL
            ORDER BY priority DESC, created_at DESC`,
          [ctx.tenantId],
        ),
        client.query<AgentOverrideRow>(
          `SELECT agent, count(*)::int AS per_user_overrides_count
             FROM user_agent_authority
            WHERE tenant_id = $1
            GROUP BY agent`,
          [ctx.tenantId],
        ),
        client.query<AgentProposalStatsRow>(
          `SELECT COALESCE(action->>'agent', action->>'agent_key', proposing_agent) AS agent,
                  count(*)::int AS weekly_decision_count,
                  count(*) FILTER (WHERE status IN ('approved','executed'))::int AS weekly_auto_count,
                  count(*) FILTER (WHERE status IN ('pending','pending_approval','awaiting_second_approval'))::int AS weekly_needed_you_count,
                  max(created_at) AS last_activity_at
             FROM proposals
            WHERE tenant_id = $1 AND created_at >= now() - interval '7 days'
            GROUP BY 1`,
          [ctx.tenantId],
        ),
        client.query<AgentAuditRow>(
          `SELECT action, max(created_at) AS last_activity_at
             FROM audit_events
            WHERE tenant_id = $1
            GROUP BY action`,
          [ctx.tenantId],
        ),
      ]);
      const rulesByAgent = new Map<string, AgentRuleRow[]>();
      for (const row of rulesResult.rows) {
        const existing = rulesByAgent.get(row.agent) ?? [];
        existing.push(row);
        rulesByAgent.set(row.agent, existing);
      }
      const overrides = new Map<string, number>(
        overridesResult.rows.map((row) => [row.agent, Number(row.per_user_overrides_count)]),
      );
      const proposals = new Map<
        string,
        { count: number; auto: number; needed: number; last: string | null }
      >(
        proposalResult.rows.map((row) => [
          row.agent,
          {
            count: Number(row.weekly_decision_count),
            auto: Number(row.weekly_auto_count),
            needed: Number(row.weekly_needed_you_count),
            last: asIso(row.last_activity_at),
          },
        ]),
      );
      const audits = auditResult.rows;
      return ROBOTMONEY_AGENT_KEYS.map((agentKey) => {
        const def = internalAgentDefinitions[agentKey];
        const proposal = proposals.get(agentKey);
        const auditLast =
          audits
            .filter((row) => row.action.includes(agentKey))
            .map((row) => asIso(row.last_activity_at))
            .filter((value): value is string => value !== null)
            .sort()
            .at(-1) ?? null;
        return {
          agent_key: agentKey,
          display_name: def?.display_name ?? agentKey,
          description: def?.intent_patterns.slice(0, 2).join(", ") ?? agentKey,
          authority_summary: {
            default: def?.default_authority ?? "propose",
            auto_conditions: (rulesByAgent.get(agentKey) ?? [])
              .filter((row) => row.authority === "auto")
              .map((row) => ({
                rule_id: row.id,
                decision: row.decision,
                condition: row.condition,
              })),
            per_user_overrides_count: overrides.get(agentKey) ?? 0,
          },
          weekly_decision_count: proposal?.count ?? 0,
          weekly_auto_count: proposal?.auto ?? 0,
          weekly_needed_you_count: proposal?.needed ?? 0,
          active_rules_count: rulesByAgent.get(agentKey)?.length ?? 0,
          last_activity_at: proposal?.last ?? auditLast,
        };
      });
    });
    reply.status(200);
    return { agents: rows };
  });

  app.get("/accounts", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_LEDGER_READ);
    const rows = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const result = await client.query<AccountRow>(
        `SELECT id, account_type, name, institution, current_balance,
                available_balance, currency, updated_at
           FROM ledger_accounts
          WHERE owner_id = $1 AND status = 'active'
          ORDER BY name ASC`,
        [ctx.tenantId],
      );
      return decorateAccounts(client, ctx.tenantId, result.rows);
    });
    reply.status(200);
    return { accounts: rows };
  });

  app.get(
    "/accounts/:id",
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { limit?: string; cursor?: string };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_LEDGER_READ);
      if (!isBrainId(request.params.id, "acct")) {
        throw brainError("request_params_invalid", "malformed account id");
      }
      const limit = parseBoundedInteger(request.query.limit, 25, 1, 100);
      const offset = parseBoundedInteger(request.query.cursor, 0, 0, 100000);
      const payload = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const accountResult = await client.query<AccountRow>(
          `SELECT id, account_type, name, institution, current_balance,
                  available_balance, currency, updated_at
             FROM ledger_accounts
            WHERE owner_id = $1 AND id = $2
            LIMIT 1`,
          [ctx.tenantId, request.params.id],
        );
        const account = accountResult.rows[0];
        if (account === undefined) return null;
        const [decorated] = await decorateAccounts(client, ctx.tenantId, [account]);
        const txResult = await client.query<AccountTransactionRow>(
          `SELECT id, amount, currency, direction, transaction_date, posted_date,
                  counterparty_id, status, description_raw, description_normalized
             FROM ledger_transactions
            WHERE owner_id = $1 AND account_id = $2
            ORDER BY transaction_date DESC, id DESC
            LIMIT $3 OFFSET $4`,
          [ctx.tenantId, request.params.id, limit + 1, offset],
        );
        const page = txResult.rows.slice(0, limit);
        return {
          account: decorated,
          transactions: page.map((row) => ({
            ...row,
            transaction_date: asIso(row.transaction_date),
            posted_date: asIso(row.posted_date),
          })),
          next_cursor: txResult.rows.length > limit ? String(offset + limit) : null,
        };
      });
      if (payload === null) throw brainError("account_not_found", "no such account");
      reply.status(200);
      return payload;
    },
  );

  app.get("/contacts", async (request, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_LEDGER_READ);
    const rows = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, name, type, risk_level, verified_status, aliases, linked_accounts,
                metadata, status, created_at, updated_at
           FROM ledger_counterparties
          WHERE owner_id = $1 AND COALESCE(status, 'active') = 'active' AND deleted_at IS NULL
          ORDER BY name ASC`,
        [ctx.tenantId],
      );
      return result.rows;
    });
    reply.status(200);
    return { data: rows };
  });

  app.post(
    "/contacts",
    async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_LEDGER_WRITE);
      const name = optionalText(request.body?.name);
      const type = optionalText(request.body?.type) ?? "other";
      if (name === null) throw brainError("request_body_invalid", "name is required");
      const id = newCounterpartyId();
      const row = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const result = await client.query(
          `INSERT INTO ledger_counterparties (
             id, owner_id, name, normalized_name, type, risk_level, verified_status,
             aliases, linked_accounts, source_ids, evidence_ids, provenance, confidence,
             metadata, status
           )
           VALUES ($1,$2,$3,lower($3),$4,$5,$6,$7,$8,ARRAY[]::TEXT[],ARRAY[]::TEXT[],
             'human_confirmed',1.0,$9::jsonb,'active')
           RETURNING *`,
          [
            id,
            ctx.tenantId,
            name,
            type,
            optionalText(request.body?.risk_level),
            optionalText(request.body?.verified_status),
            optionalTextArray(request.body?.aliases) ?? [],
            optionalTextArray(request.body?.linked_accounts) ?? [],
            JSON.stringify(request.body?.metadata ?? {}),
          ],
        );
        return result.rows[0];
      });
      reply.status(201);
      return row;
    },
  );

  app.get("/contacts/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const ctx = assertCtx(request);
    requireScope(request.principal!.scopes, SCOPE_LEDGER_READ);
    if (!isBrainId(request.params.id, "cp")) {
      throw brainError("request_params_invalid", "malformed contact id");
    }
    const row = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
      const result = await client.query(
        `SELECT *
             FROM ledger_counterparties
            WHERE owner_id = $1 AND id = $2 AND COALESCE(status, 'active') = 'active'
              AND deleted_at IS NULL
            LIMIT 1`,
        [ctx.tenantId, request.params.id],
      );
      return result.rows[0] ?? null;
    });
    if (row === null) throw brainError("contact_not_found", "no such contact");
    reply.status(200);
    return row;
  });

  app.patch(
    "/contacts/:id",
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_LEDGER_WRITE);
      if (!isBrainId(request.params.id, "cp")) {
        throw brainError("request_params_invalid", "malformed contact id");
      }
      const row = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const result = await client.query(
          `UPDATE ledger_counterparties
              SET name = COALESCE($3, name),
                  normalized_name = COALESCE(lower($3), normalized_name),
                  type = COALESCE($4, type),
                  risk_level = COALESCE($5, risk_level),
                  verified_status = COALESCE($6, verified_status),
                  aliases = COALESCE($7::TEXT[], aliases),
                  linked_accounts = COALESCE($8::TEXT[], linked_accounts),
                  metadata = COALESCE($9::jsonb, metadata),
                  updated_at = now()
            WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING *`,
          [
            ctx.tenantId,
            request.params.id,
            optionalText(request.body?.name),
            optionalText(request.body?.type),
            optionalText(request.body?.risk_level),
            optionalText(request.body?.verified_status),
            optionalTextArray(request.body?.aliases),
            optionalTextArray(request.body?.linked_accounts),
            request.body?.metadata === undefined ? null : JSON.stringify(request.body.metadata),
          ],
        );
        return result.rows[0] ?? null;
      });
      if (row === null) throw brainError("contact_not_found", "no such contact");
      reply.status(200);
      return row;
    },
  );

  app.delete(
    "/contacts/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_LEDGER_WRITE);
      if (!isBrainId(request.params.id, "cp")) {
        throw brainError("request_params_invalid", "malformed contact id");
      }
      await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        await client.query(
          `UPDATE ledger_counterparties
              SET status = 'archived', deleted_at = now(), updated_at = now()
            WHERE owner_id = $1 AND id = $2`,
          [ctx.tenantId, request.params.id],
        );
      });
      reply.status(204);
      return null;
    },
  );

  app.post(
    "/search",
    async (
      request: FastifyRequest<{
        Body: { q?: string; query?: string; kinds?: string[]; limit?: number };
      }>,
      reply,
    ) => {
      const ctx = assertCtx(request);
      requireScope(request.principal!.scopes, SCOPE_READ);
      const q = (request.body?.query ?? request.body?.q)?.trim();
      if (q === undefined || q.length < 2) {
        throw brainError("request_body_invalid", "query must be at least two characters");
      }
      const kinds = new Set(
        request.body?.kinds ?? ["proposal", "thread", "account", "counterparty", "audit_entry"],
      );
      const limit = Math.min(Math.max(request.body?.limit ?? 20, 1), 20);
      const rows = await withTenantScope(deps.pool, ctx.tenantId, async (client) => {
        const like = `%${q}%`;
        const results: Array<Record<string, unknown>> = [];
        if (kinds.has("proposal")) {
          const found = await client.query<SearchProposalRow>(
            `SELECT id, proposing_agent, status, action, created_at
               FROM proposals
              WHERE tenant_id = $1 AND (id ILIKE $2 OR proposing_agent ILIKE $2 OR action::text ILIKE $2)
              ORDER BY created_at DESC
              LIMIT $3`,
            [ctx.tenantId, like, limit],
          );
          results.push(
            ...found.rows.map((row) => ({
              kind: "proposal",
              id: row.id,
              title: row.action?.title ?? row.action?.headline ?? row.id,
              subtitle: row.proposing_agent,
              ref_url: `/proposals/${row.id}`,
              score: 1,
            })),
          );
        }
        if (kinds.has("thread")) {
          const found = await client.query(
            `SELECT id, title, updated_at
               FROM robo_threads
              WHERE tenant_id = $1 AND title ILIKE $2
              ORDER BY updated_at DESC
              LIMIT $3`,
            [ctx.tenantId, like, limit],
          );
          results.push(
            ...found.rows.map((row) => ({
              kind: "thread",
              id: row.id,
              title: row.title,
              ref_url: `/threads/${row.id}`,
              score: 1,
            })),
          );
        }
        if (kinds.has("account")) {
          const found = await client.query(
            `SELECT id, name, institution, account_type, current_balance, currency
               FROM ledger_accounts
              WHERE owner_id = $1 AND (name ILIKE $2 OR institution ILIKE $2)
              ORDER BY updated_at DESC
              LIMIT $3`,
            [ctx.tenantId, like, limit],
          );
          results.push(
            ...found.rows.map((row) => ({
              kind: "account",
              id: row.id,
              title: row.name,
              subtitle: row.institution,
              ref_url: `/accounts/${row.id}`,
              score: 1,
            })),
          );
        }
        if (kinds.has("contact") || kinds.has("counterparty")) {
          const found = await client.query(
            `SELECT id, name, type
               FROM ledger_counterparties
              WHERE owner_id = $1 AND deleted_at IS NULL
                AND (name ILIKE $2 OR type ILIKE $2)
              ORDER BY name ASC
              LIMIT $3`,
            [ctx.tenantId, like, limit],
          );
          results.push(
            ...found.rows.map((row) => ({
              kind: "counterparty",
              id: row.id,
              title: row.name,
              subtitle: row.type,
              ref_url: `/contacts/${row.id}`,
              score: 1,
            })),
          );
        }
        if (kinds.has("decision") || kinds.has("audit_entry")) {
          const found = await client.query(
            `SELECT id, action, actor, created_at
               FROM audit_events
              WHERE tenant_id = $1 AND (id ILIKE $2 OR action ILIKE $2 OR actor ILIKE $2)
              ORDER BY created_at DESC
              LIMIT $3`,
            [ctx.tenantId, like, limit],
          );
          results.push(
            ...found.rows.map((row) => ({
              kind: "audit_entry",
              id: row.id,
              title: row.action,
              subtitle: row.actor,
              ref_url: `/audit/${row.id}`,
              score: 1,
            })),
          );
        }
        return results;
      });
      reply.status(200);
      return rows;
    },
  );
}
