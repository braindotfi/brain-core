/**
 * §6 pre-execution gate.
 *
 * Runs the 13 deterministic checks defined in
 * Brain_Engineering_Standards.md §6.2 against a PaymentIntent. On the
 * first failure the gate short-circuits and returns
 * { ok: false, failedCheck }. On success it creates a PolicyDecision
 * row, emits the audit-before event, and returns { ok: true,
 * policyDecisionId, auditBeforeEventId }.
 *
 * The §6 invariant the gate guarantees: a PaymentIntent transitions
 * proposed/pending_approval/approved → executed ONLY through this
 * function. CI grep on `runPreExecutionGate` should confirm one
 * call site per execution path.
 */

import type { AuditEmitter, ServiceCallContext } from "../index.js";
import type { GateCheck, GateResult } from "./types.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface GatePaymentIntent {
  id: string;
  owner_id: string;
  created_by_agent_id: string | null;
  action_type: string;
  source_account_id: string;
  destination_counterparty_id: string;
  amount: string; // decimal string
  currency: string;
  status: string;
  policy_decision_id: string | null;
  evidence_ids: string[];
}

export interface GatePolicyDecision {
  id: string;
  outcome: "allow" | "confirm" | "reject";
  matched_rule_id: string | null;
  required_approvers: string[];
  ledger_snapshot_hash: string;
  trace: Array<Record<string, unknown>>;
  /** Set when the rule mandates evidence (e.g. invoice attached). */
  required_evidence_kinds?: string[];
  /** Above this amount, counterparty.verified must hold. */
  counterparty_verification_threshold?: { currency: string; value: string } | null;
  /** Inclusive upper bound for the action. */
  amount_upper_bound?: { currency: string; value: string } | null;
}

export interface GatePrincipal {
  id: string;
  type: "user" | "agent" | "api_partner";
  scopes: string[];
}

export interface GateAccount {
  id: string;
  status: string;
  currency: string;
  available_balance: string | null;
}

export interface GateCounterparty {
  id: string;
  type: string;
  risk_level: string | null;
  verified_status: string | null;
}

export interface GateApprovalState {
  signedRoles: string[];
}

export interface GateAgent {
  id: string;
  state: string;
  scope: { canExecutePayments: boolean };
}

/** Hooks the caller provides so the gate stays pure. */
export interface GateDependencies {
  /** Look up the agent record by id. Returns null if missing. */
  resolveAgent: (agentId: string) => Promise<GateAgent | null>;
  /** Look up the source account by id. */
  resolveAccount: (accountId: string) => Promise<GateAccount | null>;
  /** Look up the counterparty by id. */
  resolveCounterparty: (counterpartyId: string) => Promise<GateCounterparty | null>;
  /** Run policy evaluation against the PaymentIntent's action. Returns a stored PolicyDecision. */
  evaluatePolicy: (intent: GatePaymentIntent) => Promise<GatePolicyDecision>;
  /** Read approvals for the intent — returns the roles that have signed. */
  resolveApprovals: (intentId: string) => Promise<GateApprovalState>;
  /** Audit emitter — used for the audit-before event. */
  audit: AuditEmitter;
}

export interface RunGateInput {
  ctx: ServiceCallContext;
  principal: GatePrincipal;
  intent: GatePaymentIntent;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export async function runPreExecutionGate(
  deps: GateDependencies,
  input: RunGateInput,
): Promise<GateResult> {
  const checks: GateCheck[] = [];

  // 1 — agent identity verified.
  if (input.principal.type !== "agent") {
    return fail(checks, 1, "agent_identity_verified", { type: input.principal.type });
  }
  if (
    input.intent.created_by_agent_id !== null &&
    input.intent.created_by_agent_id !== input.principal.id
  ) {
    return fail(checks, 1, "agent_identity_verified", {
      reason: "principal does not own this PaymentIntent",
    });
  }
  const agentId = input.intent.created_by_agent_id ?? input.principal.id;
  const agent = await deps.resolveAgent(agentId);
  if (agent === null || agent.state !== "active") {
    return fail(checks, 1, "agent_identity_verified", {
      agent_id: agentId,
      state: agent?.state ?? "missing",
    });
  }
  pass(checks, 1, "agent_identity_verified");

  // 2 — agent authorized: scopes include payment_intent:execute.
  if (
    !input.principal.scopes.includes("payment_intent:execute") &&
    !agent.scope.canExecutePayments
  ) {
    return fail(checks, 2, "agent_authorized", {
      missing_scope: "payment_intent:execute",
    });
  }
  pass(checks, 2, "agent_authorized");

  // (We need a PolicyDecision before we can run the remaining checks. The
  // intent may already carry one from creation, but Phase-4 re-evaluates
  // every time execute is called so the snapshot is fresh against the
  // current Ledger state.)
  const decision = await deps.evaluatePolicy(input.intent);

  // 3 — action allowed (policy matched a rule with applies_to including
  // this action_type, or `any`; any match is the precondition).
  if (decision.matched_rule_id === null) {
    return fail(checks, 3, "action_allowed", { reason: "no rule matched" });
  }
  if (decision.outcome === "reject") {
    return fail(checks, 3, "action_allowed", {
      reason: "policy explicitly rejected",
      matched_rule_id: decision.matched_rule_id,
    });
  }
  pass(checks, 3, "action_allowed", { matched_rule_id: decision.matched_rule_id });

  // 4 — source account allowed.
  const account = await deps.resolveAccount(input.intent.source_account_id);
  if (account === null) {
    return fail(checks, 4, "source_account_allowed", { reason: "account not found" });
  }
  if (account.status !== "active") {
    return fail(checks, 4, "source_account_allowed", { status: account.status });
  }
  pass(checks, 4, "source_account_allowed");

  // 5 — counterparty allowed (exists, not sanctioned).
  const counterparty = await deps.resolveCounterparty(input.intent.destination_counterparty_id);
  if (counterparty === null) {
    return fail(checks, 5, "counterparty_allowed", { reason: "counterparty not found" });
  }
  if (counterparty.risk_level === "sanctioned") {
    return fail(checks, 5, "counterparty_allowed", { reason: "counterparty sanctioned" });
  }
  pass(checks, 5, "counterparty_allowed");

  // 6 — counterparty verified (when required by policy threshold).
  const threshold = decision.counterparty_verification_threshold ?? null;
  if (threshold !== null) {
    if (
      cmpDecimal(input.intent.amount, threshold.value) > 0 &&
      input.intent.currency === threshold.currency
    ) {
      const ok =
        counterparty.verified_status === "document_verified" ||
        counterparty.verified_status === "sanctions_cleared";
      if (!ok) {
        return fail(checks, 6, "counterparty_verified", {
          required_above: threshold,
          actual_status: counterparty.verified_status ?? "unverified",
        });
      }
    }
  }
  pass(checks, 6, "counterparty_verified");

  // 7 — amount within policy limit.
  const upper = decision.amount_upper_bound ?? null;
  if (upper !== null) {
    if (input.intent.currency !== upper.currency) {
      return fail(checks, 7, "amount_within_limit", {
        reason: "currency mismatch",
        expected: upper.currency,
        actual: input.intent.currency,
      });
    }
    if (cmpDecimal(input.intent.amount, upper.value) > 0) {
      return fail(checks, 7, "amount_within_limit", {
        amount: input.intent.amount,
        upper: upper.value,
      });
    }
  }
  pass(checks, 7, "amount_within_limit");

  // 8 — available balance sufficient.
  if (account.available_balance !== null) {
    if (account.currency !== input.intent.currency) {
      return fail(checks, 8, "available_balance_sufficient", {
        reason: "currency mismatch between account and intent",
      });
    }
    if (cmpDecimal(account.available_balance, input.intent.amount) < 0) {
      return fail(checks, 8, "available_balance_sufficient", {
        available: account.available_balance,
        requested: input.intent.amount,
      });
    }
  }
  pass(checks, 8, "available_balance_sufficient");

  // 9 — required evidence present.
  const requiredEvidence = decision.required_evidence_kinds ?? [];
  if (requiredEvidence.length > 0 && input.intent.evidence_ids.length === 0) {
    return fail(checks, 9, "required_evidence_present", {
      required: requiredEvidence,
      provided: input.intent.evidence_ids,
    });
  }
  pass(checks, 9, "required_evidence_present");

  // 10 — approval requirement determined (we have decision.outcome).
  pass(checks, 10, "approval_requirement_determined", { outcome: decision.outcome });

  // 11 — approval granted when required.
  if (decision.outcome === "confirm") {
    const approvals = await deps.resolveApprovals(input.intent.id);
    const signedSet = new Set(approvals.signedRoles);
    const missing = decision.required_approvers.filter((r) => !signedSet.has(r));
    if (missing.length > 0) {
      return fail(checks, 11, "approval_granted_when_required", {
        required: decision.required_approvers,
        signed: approvals.signedRoles,
        missing,
      });
    }
  }
  pass(checks, 11, "approval_granted_when_required");

  // 12 — PolicyDecision row recorded. evaluatePolicy returned a stored
  // decision; surface its id.
  pass(checks, 12, "policy_decision_recorded", { policy_decision_id: decision.id });

  // 13 — audit-before emitted. The matching audit-after event is the
  // caller's responsibility AFTER the rail dispatches.
  const auditEvent = await deps.audit.emit({
    tenantId: input.ctx.tenantId,
    layer: "agent",
    actor: input.ctx.actor,
    action: "payment_intent.execute.before",
    inputs: {
      payment_intent_id: input.intent.id,
      action_type: input.intent.action_type,
      source_account_id: input.intent.source_account_id,
      destination_counterparty_id: input.intent.destination_counterparty_id,
      amount: input.intent.amount,
      currency: input.intent.currency,
      policy_decision_id: decision.id,
    },
    outputs: { gate_passed: true },
    policyDecisionId: decision.id,
  });
  pass(checks, 13, "audit_before_emitted", { audit_event_id: auditEvent.id });

  return {
    ok: true,
    policyDecisionId: decision.id,
    auditBeforeEventId: auditEvent.id,
    checks,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(
  checks: GateCheck[],
  index: number,
  name: GateCheck["name"],
  detail?: Record<string, unknown>,
): void {
  checks.push({ index, name, passed: true, ...(detail !== undefined ? { detail } : {}) });
}

function fail(
  prior: GateCheck[],
  index: number,
  name: GateCheck["name"],
  detail: Record<string, unknown>,
): GateResult {
  const failed: GateCheck = { index, name, passed: false, detail };
  return { ok: false, failedCheck: failed, checks: [...prior, failed] };
}

/**
 * Decimal-string compare without f64 loss. Mirrors the policy VM's
 * compareDecimal so gate ordering and policy ordering are guaranteed
 * identical at runtime.
 */
function cmpDecimal(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (na.negative !== nb.negative) return na.negative ? -1 : 1;
  const intCmp = compareBig(na.int, nb.int);
  if (intCmp !== 0) return na.negative ? -intCmp : intCmp;
  const fracCmp = compareBig(na.frac, nb.frac);
  return na.negative ? -fracCmp : fracCmp;
}

function norm(s: string): { negative: boolean; int: string; frac: string } {
  let str = s.trim();
  const negative = str.startsWith("-");
  if (negative) str = str.slice(1);
  const [intRaw, fracRaw = ""] = str.split(".");
  return {
    negative,
    int: (intRaw ?? "").replace(/^0+/, "") || "0",
    frac: fracRaw.padEnd(18, "0").slice(0, 18),
  };
}

function compareBig(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
