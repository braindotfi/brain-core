/**
 * Gate-loader factory functions used to wire ExecutionDeps / PaymentIntentDeps
 * + the P0.4 approver/quorum hooks + the P0.5 invoice shortcut resolver.
 *
 * These were inlined at the top of main.ts; extracting them gives the
 * composition root a flat surface and makes each loader independently
 * importable + testable.
 */

import {
  withTenantScope,
  type ServiceCallContext,
  type GateAgent,
  type GateAccount,
  type GateCounterparty,
  type GatePrincipal,
  type GateTenantFlags,
} from "@brain/shared";
import { getActive as policyGetActive } from "@brain/policy";
import {
  findAgent,
  findUser,
  resolveInvoiceShortcut as resolveInvoiceShortcutFn,
} from "@brain/execution";
import type { LedgerService } from "@brain/ledger";
import type { InvoiceShortcutInvoice, ResolvedInvoiceShortcut } from "@brain/execution";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Gate principal/agent/account/counterparty/tenant-flag loaders
// ---------------------------------------------------------------------------

export function makeResolveAgent(
  pool: Pool,
): (ctx: ServiceCallContext, agentId: string) => Promise<GateAgent | null> {
  return async (ctx, agentId) => {
    const row = await withTenantScope(pool, ctx.tenantId, (c) => findAgent(c, agentId));
    if (row === null) return null;
    return {
      id: row.id,
      state: row.state,
      scope: { canExecutePayments: row.state === "active" && row.role === "payment" },
    };
  };
}

export function makeResolveTenantFlags(
  pool: Pool,
): (ctx: ServiceCallContext, tenantId: string) => Promise<GateTenantFlags> {
  return async (ctx, tenantId) => {
    // No row ⇒ flags default off (back-compat). RLS scopes the read to the
    // caller's own tenant; we also filter by id so an admin BYPASSRLS connection
    // would still read the correct tenant.
    const row = await withTenantScope(pool, ctx.tenantId, async (c) => {
      const res = await c.query<{ require_behavior_hash: boolean }>(
        `SELECT require_behavior_hash FROM tenants WHERE id = $1`,
        [tenantId],
      );
      return res.rows[0] ?? null;
    });
    return { requireBehaviorHash: row?.require_behavior_hash ?? false };
  };
}

export function makeResolveAccount(
  ledger: LedgerService,
): (ctx: ServiceCallContext, accountId: string) => Promise<GateAccount | null> {
  return async (ctx, accountId) => {
    const result = await ledger.getAccount(ctx, accountId);
    if (result === null) return null;
    return {
      id: result.account.id,
      status: result.account.status,
      currency: result.account.currency,
      available_balance:
        result.latest_balance !== null
          ? result.latest_balance.available_balance
          : result.account.available_balance,
    };
  };
}

export function makeResolveCounterparty(
  ledger: LedgerService,
): (ctx: ServiceCallContext, counterpartyId: string) => Promise<GateCounterparty | null> {
  return async (ctx, counterpartyId) => {
    const cp = await ledger.findCounterpartyById(ctx, counterpartyId);
    if (cp === null) return null;
    return {
      id: cp.id,
      type: cp.type,
      risk_level: cp.risk_level ?? null,
      verified_status: cp.verified_status ?? null,
      // RFC 0001 §6.3 / §6.1 — agent attestation (check 5.5) + x402 recipient
      // match (check 6.5). Null for non-agent / off-chain counterparties.
      agent_id: cp.agent_id ?? null,
      onchain_address: cp.onchain_address ?? null,
    };
  };
}

export function resolvePrincipalFromCtx(ctx: ServiceCallContext): Promise<GatePrincipal> {
  return Promise.resolve({
    id: ctx.actor,
    type: ctx.principalType ?? "user",
    scopes: ctx.scopes !== undefined ? [...ctx.scopes] : [],
  });
}

export function makeResolveRole(
  pool: Pool,
): (ctx: ServiceCallContext, principalId: string) => Promise<string | null> {
  return async (ctx, principalId) => {
    const agentRow = await withTenantScope(pool, ctx.tenantId, (c) => findAgent(c, principalId));
    if (agentRow !== null) return agentRow.role;
    const userRow = await withTenantScope(pool, ctx.tenantId, (c) => findUser(c, principalId));
    return userRow?.role ?? null;
  };
}

// ---------------------------------------------------------------------------
// P0.4 approver/quorum hardening hooks
// ---------------------------------------------------------------------------

export function makeIsApproverActive(
  pool: Pool,
): (ctx: ServiceCallContext, principalId: string) => Promise<boolean> {
  return async (ctx, principalId) =>
    withTenantScope(pool, ctx.tenantId, async (c) => {
      const agent = await findAgent(c, principalId);
      if (agent !== null) return agent.state === "active";
      // MVP user model has no revocation column; existence ⇒ active approver.
      // TODO(brain-hardening): honor a user.status/disabled flag once it exists.
      const user = await findUser(c, principalId);
      return user !== null;
    });
}

export function makeResolveSubjectOwnerTenant(
  pool: Pool,
): (
  ctx: ServiceCallContext,
  subject: { type: "payment_intent" | "proposal"; id: string },
) => Promise<string | null> {
  return async (ctx, subject) =>
    withTenantScope(pool, ctx.tenantId, async (c) => {
      if (subject.type === "payment_intent") {
        const { rows } = await c.query<{ owner_id: string }>(
          `SELECT owner_id FROM ledger_payment_intents WHERE id = $1`,
          [subject.id],
        );
        return rows[0]?.owner_id ?? null;
      }
      const { rows } = await c.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM proposals WHERE id = $1`,
        [subject.id],
      );
      return rows[0]?.tenant_id ?? null;
    });
}

export function makeResolveActivePolicyVersion(
  pool: Pool,
): (ctx: ServiceCallContext) => Promise<number | null> {
  return async (ctx) =>
    withTenantScope(pool, ctx.tenantId, async (c) => {
      const active = await policyGetActive(c);
      return active?.version ?? null;
    });
}

// ---------------------------------------------------------------------------
// P0.5 invoice shortcut resolver (LedgerService-backed lookups)
// ---------------------------------------------------------------------------

export function makeInvoiceShortcutResolver(
  ledger: LedgerService,
  pool: Pool,
): (ctx: ServiceCallContext, invoiceId: string) => Promise<ResolvedInvoiceShortcut> {
  return (ctx, invoiceId) =>
    resolveInvoiceShortcutFn(
      {
        resolveInvoice: async (c, id): Promise<InvoiceShortcutInvoice | null> => {
          const inv = await ledger.findInvoiceById(c, id);
          if (inv === null) return null;
          return {
            id: inv.id,
            counterparty_id: inv.counterparty_id,
            amount_due: String(inv.amount_due),
            amount_paid: String(inv.amount_paid),
            currency: inv.currency,
            status: inv.status,
            linked_document_ids: inv.linked_document_ids,
            linked_transaction_ids: inv.linked_transaction_ids,
          };
        },
        listApAccounts: async (c): Promise<string[]> => {
          const res = await ledger.listAccounts(c, { status: "active", limit: 500 });
          return res.items
            .filter((a) => a.account_type === "bank_checking" || a.account_type === "bank_savings")
            .map((a) => a.id);
        },
        resolveDefaultApAccount: (c): Promise<string | null> =>
          withTenantScope(pool, c.tenantId, async (cl) => {
            const r = await cl.query<{ default_ap_account_id: string | null }>(
              `SELECT default_ap_account_id FROM tenants WHERE id = $1`,
              [c.tenantId],
            );
            return r.rows[0]?.default_ap_account_id ?? null;
          }),
      },
      ctx,
      invoiceId,
    );
}
