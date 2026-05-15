/**
 * Sandbox-mode dependency hooks for the boot binary.
 *
 * These replace the throw-stubs in main.ts when BRAIN_DEMO_MODE=true.
 * They allow the §6 gate and PaymentIntent flow to complete end-to-end
 * against real seeded Ledger data without live Policy or Agent services.
 *
 * None of these are safe for production — they assume any agent is active
 * and any payment is policy-approved. CI will fail if this module is
 * imported outside of a BRAIN_DEMO_MODE guard.
 */

import type { Pool } from "pg";
import {
  brainId,
  ID_PREFIX,
  withTenantScope,
  type GateAccount,
  type GateAgent,
  type GateCounterparty,
  type GatePaymentIntent,
  type GatePolicyDecision,
  type GatePrincipal,
  type ServiceCallContext,
} from "@brain/api/shared";

// ---------------------------------------------------------------------------
// evaluatePaymentIntent — always allows; no policy rule evaluation
// ---------------------------------------------------------------------------

export async function sandboxEvaluatePaymentIntent(
  _ctx: ServiceCallContext,
  _intent: GatePaymentIntent,
): Promise<GatePolicyDecision> {
  return {
    id: brainId(ID_PREFIX.policyDecision),
    outcome: "allow",
    matched_rule_id: "sandbox-allow-all",
    required_approvers: [],
    ledger_snapshot_hash: "sandbox-snapshot-0000000000000000",
    trace: [{ check: "sandbox_allow_all", result: "pass", reason: "BRAIN_DEMO_MODE" }],
    required_evidence_kinds: [],
    counterparty_verification_threshold: null,
    amount_upper_bound: null,
  };
}

// ---------------------------------------------------------------------------
// resolvePrincipal — returns an agent principal so §6 check 1 passes
// ---------------------------------------------------------------------------

export async function sandboxResolvePrincipal(
  ctx: ServiceCallContext,
): Promise<GatePrincipal> {
  return {
    id: ctx.actor,
    // Must be "agent" — gate check 1 rejects non-agent principals.
    type: "agent",
    scopes: ["payment_intent:execute", "raw:write", "ledger:read", "wiki:read", "audit:read"],
  };
}

// ---------------------------------------------------------------------------
// resolveAgent — returns a synthetic active agent for the calling actor
// ---------------------------------------------------------------------------

export async function sandboxResolveAgent(
  _ctx: ServiceCallContext,
  agentId: string,
): Promise<GateAgent | null> {
  return {
    id: agentId,
    state: "active",
    scope: { canExecutePayments: true },
  };
}

// ---------------------------------------------------------------------------
// resolveAccount — queries ledger_accounts by id under tenant scope
// ---------------------------------------------------------------------------

export function makeSandboxResolveAccount(
  pool: Pool,
): (ctx: ServiceCallContext, accountId: string) => Promise<GateAccount | null> {
  return async (ctx, accountId) => {
    return withTenantScope(pool, ctx.tenantId, async (client) => {
      const res = await client.query<{
        id: string;
        status: string;
        currency: string;
        available_balance: string | null;
      }>(
        `SELECT id, status, currency, available_balance::text AS available_balance
           FROM ledger_accounts
          WHERE id = $1`,
        [accountId],
      );
      return res.rows[0] ?? null;
    });
  };
}

// ---------------------------------------------------------------------------
// resolveCounterparty — queries ledger_counterparties by id
// ---------------------------------------------------------------------------

export function makeSandboxResolveCounterparty(
  pool: Pool,
): (ctx: ServiceCallContext, counterpartyId: string) => Promise<GateCounterparty | null> {
  return async (ctx, counterpartyId) => {
    return withTenantScope(pool, ctx.tenantId, async (client) => {
      const res = await client.query<{
        id: string;
        type: string;
        risk_level: string | null;
        verified_status: string | null;
      }>(
        `SELECT id, type, risk_level, verified_status
           FROM ledger_counterparties
          WHERE id = $1`,
        [counterpartyId],
      );
      return res.rows[0] ?? null;
    });
  };
}

// ---------------------------------------------------------------------------
// resolveRole — always owner in sandbox
// ---------------------------------------------------------------------------

export async function sandboxResolveRole(
  _ctx: ServiceCallContext,
  _principalId: string,
): Promise<string | null> {
  return "owner";
}

// ---------------------------------------------------------------------------
// Legacy evaluatePolicy (used by ExecutionDeps.evaluatePolicy, not §6 gate)
// ---------------------------------------------------------------------------

export async function sandboxEvaluateLegacyPolicy(
  _tenantId: string,
  _action: Record<string, unknown>,
): Promise<{
  outcome: "allow" | "confirm" | "reject";
  matched_rule_id: string | null;
  required_approvers: string[];
  trace: unknown[];
  policy_version: number;
}> {
  return {
    outcome: "allow",
    matched_rule_id: "sandbox-allow-all",
    required_approvers: [],
    trace: [{ check: "sandbox_allow_all", result: "pass" }],
    policy_version: 1,
  };
}
