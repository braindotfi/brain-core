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

import { createHash } from "node:crypto";
import type { AuditEmitter } from "../audit/emitter.js";
import type { ServiceCallContext } from "../contracts/types.js";
import { computeLedgerSnapshot } from "./snapshot.js";
import { validateEvidence, type ResolvedEvidence, type RiskLevel } from "./evidence-validator.js";
import type { DuplicateCheckInput, DuplicateCheckResult } from "./duplicate.js";
import type { GateCheck, GateOutcome, GateResult } from "./types.js";

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
  /** Optional linkage used by evidence semantic validation (H-21, check 9.5). */
  invoice_id?: string | null;
  obligation_id?: string | null;
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
  /** behaviorHash registered on-chain for this agent (2.3). */
  behaviorHash?: string | null;
  /** Manifest max risk level — gates the evidence source-trust rule (H-21). */
  max_risk_level?: RiskLevel;
}

/** Options passed to the single policy evaluator (1a.2 — one evaluator, two modes). */
export interface GateEvalOptions {
  /**
   * In dry-run the evaluator runs the SAME policy VM but does NOT persist a
   * policy_decisions row. INV-3: there is exactly one evaluator; dry-run only
   * suppresses the side effect, never forks the logic.
   */
  dryRun: boolean;
}

/** Optional cache for the dry-run trace so a later live call can avoid rework. */
export interface GateTraceCache {
  set: (key: string, trace: Array<Record<string, unknown>>, ttlSeconds: number) => Promise<void>;
}

/** Hooks the caller provides so the gate stays pure. */
export interface GateDependencies {
  /** Look up the agent record by id. Returns null if missing. */
  resolveAgent: (agentId: string) => Promise<GateAgent | null>;
  /** Look up the source account by id. */
  resolveAccount: (accountId: string) => Promise<GateAccount | null>;
  /** Look up the counterparty by id. */
  resolveCounterparty: (counterpartyId: string) => Promise<GateCounterparty | null>;
  /**
   * Run policy evaluation against the PaymentIntent's action. The SAME evaluator
   * serves live and dry-run; in dry-run it must NOT persist the policy_decisions
   * row (opts.dryRun === true). Returns the (possibly unpersisted) PolicyDecision.
   */
  evaluatePolicy: (intent: GatePaymentIntent, opts: GateEvalOptions) => Promise<GatePolicyDecision>;
  /** Read approvals for the intent — returns the roles that have signed. */
  resolveApprovals: (intentId: string) => Promise<GateApprovalState>;
  /** Audit emitter — used for the audit-before event (live mode only). */
  audit: AuditEmitter;
  /** Optional dry-run trace cache (60s TTL). Written in dry-run only. */
  traceCache?: GateTraceCache;
  /**
   * Sum of active balance reservations against the source account (1b.1), as a
   * decimal string. Check #8 subtracts it so parallel money-movers can't
   * double-spend the same balance. Read-only — evaluated in dry-run too.
   */
  sumActiveReservations?: (accountId: string) => Promise<string>;
  /**
   * Loads the resolved evidence rows (full `extracted` payloads, DB-enriched)
   * for check 9.5 (H-21). Injected because the gate (shared) must not query the
   * DB directly; the loader lives in services/policy. When absent, check 9.5
   * records as not-applicable. Read-only — runs in dry-run too.
   */
  resolveEvidence?: (intent: GatePaymentIntent) => Promise<ResolvedEvidence[]>;
  /**
   * Duplicate-payment detector (H-22, check 11.5). DB-backed; lives in
   * services/policy and is injected (the gate must not query the DB). When
   * absent, check 11.5 records not-applicable. A collision is a HARD reject
   * even with an approval present.
   */
  detectDuplicates?: (input: DuplicateCheckInput) => Promise<DuplicateCheckResult>;
}

export interface RunGateInput {
  ctx: ServiceCallContext;
  principal: GatePrincipal;
  intent: GatePaymentIntent;
  /**
   * When true, run all 13 checks against the same Ledger state but DO NOT
   * insert a policy_decisions row, write a reservation, or emit audit
   * before/after. Used by the agent layer to short-circuit obvious rejects and
   * to pick confirm vs execute before building a proposal (plan 1a.2).
   */
  dryRun?: boolean;
  /**
   * The behaviorHash of the model/prompt/tools actually used at runtime (2.3).
   * When supplied, gate check 1.5 requires it to equal the agent's registered
   * behaviorHash; a mismatch rejects regardless of all other checks.
   */
  runtimeBehaviorHash?: string;
}

/** TTL for the cached dry-run trace. */
const DRY_RUN_TRACE_TTL_SECONDS = 60;

/** Canonical cache key for a candidate intent's dry-run trace. */
export function gateTraceCacheKey(intent: GatePaymentIntent): string {
  const canonical = JSON.stringify({
    owner: intent.owner_id,
    agent: intent.created_by_agent_id,
    action: intent.action_type,
    src: intent.source_account_id,
    dst: intent.destination_counterparty_id,
    amount: intent.amount,
    currency: intent.currency,
    evidence: [...intent.evidence_ids].sort(),
  });
  return `gate:dryrun:${createHash("sha256").update(canonical).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export async function runPreExecutionGate(
  deps: GateDependencies,
  input: RunGateInput,
): Promise<GateResult> {
  const checks: GateCheck[] = [];
  const dryRun = input.dryRun ?? false;
  let outcome: GateOutcome | null = null;
  let requiredApprovers: string[] = [];
  let trace: Array<Record<string, unknown>> = [];

  // Local failure builder: captures the current outcome/approvers/trace so a
  // failure before policy eval reports nulls and one after reports the decision.
  const failGate = (
    index: number,
    name: GateCheck["name"],
    detail: Record<string, unknown>,
  ): GateResult => {
    const failed: GateCheck = { index, name, passed: false, detail };
    return {
      ok: false,
      dryRun,
      outcome,
      requiredApprovers,
      failedCheck: failed,
      checks: [...checks, failed],
      trace,
    };
  };

  // 1 — agent identity verified.
  if (input.principal.type !== "agent") {
    return failGate(1, "agent_identity_verified", { type: input.principal.type });
  }
  if (
    input.intent.created_by_agent_id !== null &&
    input.intent.created_by_agent_id !== input.principal.id
  ) {
    return failGate(1, "agent_identity_verified", {
      reason: "principal does not own this PaymentIntent",
    });
  }
  const agentId = input.intent.created_by_agent_id ?? input.principal.id;
  const agent = await deps.resolveAgent(agentId);
  if (agent === null || agent.state !== "active") {
    return failGate(1, "agent_identity_verified", {
      agent_id: agentId,
      state: agent?.state ?? "missing",
    });
  }
  pass(checks, 1, "agent_identity_verified");

  // 1.5 — agent behavior pinned (2.3). Verified only when a runtime behaviorHash
  // is supplied AND the agent has a registered hash; a mismatch is a hard reject
  // regardless of every other signal. Skipped (no check row) when unverifiable,
  // so the happy path remains the canonical 13 checks.
  if (
    input.runtimeBehaviorHash !== undefined &&
    agent.behaviorHash !== undefined &&
    agent.behaviorHash !== null
  ) {
    if (agent.behaviorHash !== input.runtimeBehaviorHash) {
      return failGate(1.5, "agent_behavior_pinned", {
        registered: agent.behaviorHash,
        runtime: input.runtimeBehaviorHash,
      });
    }
    pass(checks, 1.5, "agent_behavior_pinned");
  }

  // 2 — agent authorized: scopes include payment_intent:execute.
  if (
    !input.principal.scopes.includes("payment_intent:execute") &&
    !agent.scope.canExecutePayments
  ) {
    return failGate(2, "agent_authorized", {
      missing_scope: "payment_intent:execute",
    });
  }
  pass(checks, 2, "agent_authorized");

  // (We need a PolicyDecision before we can run the remaining checks. The
  // intent may already carry one from creation, but Phase-4 re-evaluates
  // every time execute is called so the snapshot is fresh against the
  // current Ledger state.)
  const decision = await deps.evaluatePolicy(input.intent, { dryRun });
  outcome = decision.outcome;
  requiredApprovers = decision.required_approvers;
  trace = decision.trace;

  // 3 — action allowed (policy matched a rule with applies_to including
  // this action_type, or `any`; any match is the precondition).
  if (decision.matched_rule_id === null) {
    return failGate(3, "action_allowed", { reason: "no rule matched" });
  }
  if (decision.outcome === "reject") {
    return failGate(3, "action_allowed", {
      reason: "policy explicitly rejected",
      matched_rule_id: decision.matched_rule_id,
    });
  }
  pass(checks, 3, "action_allowed", { matched_rule_id: decision.matched_rule_id });

  // 4 — source account allowed.
  const account = await deps.resolveAccount(input.intent.source_account_id);
  if (account === null) {
    return failGate(4, "source_account_allowed", { reason: "account not found" });
  }
  if (account.status !== "active") {
    return failGate(4, "source_account_allowed", { status: account.status });
  }
  pass(checks, 4, "source_account_allowed");

  // 5 — counterparty allowed (exists, not sanctioned).
  const counterparty = await deps.resolveCounterparty(input.intent.destination_counterparty_id);
  if (counterparty === null) {
    return failGate(5, "counterparty_allowed", { reason: "counterparty not found" });
  }
  if (counterparty.risk_level === "sanctioned") {
    return failGate(5, "counterparty_allowed", { reason: "counterparty sanctioned" });
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
        return failGate(6, "counterparty_verified", {
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
      return failGate(7, "amount_within_limit", {
        reason: "currency mismatch",
        expected: upper.currency,
        actual: input.intent.currency,
      });
    }
    if (cmpDecimal(input.intent.amount, upper.value) > 0) {
      return failGate(7, "amount_within_limit", {
        amount: input.intent.amount,
        upper: upper.value,
      });
    }
  }
  pass(checks, 7, "amount_within_limit");

  // 7.5 — ledger-state binding. Snapshot the security-relevant state the gate
  // resolved (source account + counterparty) so the audit-before event and the
  // GateResult carry a verifiable, tamper-evident record of exactly what money
  // moved against (consumed by the Proof API). This never fails — the dangerous
  // deltas are already rejected by checks 5/6/8, which read this same state.
  const ledgerStateHash = computeLedgerSnapshot({ account, counterparty });
  pass(checks, 7.5, "ledger_state_bound", { ledger_state_hash: ledgerStateHash });

  // 8 — available balance sufficient, net of active reservations (1b.1):
  //   available_balance - SUM(active reservations) >= amount
  // i.e. available_balance >= amount + reserved. Reservations are read-only here,
  // so the same check holds in dry-run.
  if (account.available_balance !== null) {
    if (account.currency !== input.intent.currency) {
      return failGate(8, "available_balance_sufficient", {
        reason: "currency mismatch between account and intent",
      });
    }
    const reserved = (await deps.sumActiveReservations?.(input.intent.source_account_id)) ?? "0";
    const required = addDecimalString(input.intent.amount, reserved);
    if (cmpDecimal(account.available_balance, required) < 0) {
      return failGate(8, "available_balance_sufficient", {
        available: account.available_balance,
        requested: input.intent.amount,
        reserved,
      });
    }
  }
  pass(checks, 8, "available_balance_sufficient");

  // 9 — required evidence present.
  const requiredEvidence = decision.required_evidence_kinds ?? [];
  if (requiredEvidence.length > 0 && input.intent.evidence_ids.length === 0) {
    return failGate(9, "required_evidence_present", {
      required: requiredEvidence,
      provided: input.intent.evidence_ids,
    });
  }
  pass(checks, 9, "required_evidence_present");

  // 9.5 — evidence semantic validation (H-21). Check 9 verifies evidence
  // references exist; this verifies they SUPPORT the action (amount /
  // counterparty / currency / freshness / source-trust). When no evidence
  // loader is wired, it records as not-applicable (additive, non-breaking).
  if (deps.resolveEvidence !== undefined) {
    const resolvedEvidence = await deps.resolveEvidence(input.intent);
    const evidenceResult = validateEvidence({
      actionType: input.intent.action_type,
      paymentIntent: {
        counterpartyId: input.intent.destination_counterparty_id,
        amount: input.intent.amount,
        currency: input.intent.currency,
        ...(input.intent.invoice_id != null ? { invoiceId: input.intent.invoice_id } : {}),
        ...(input.intent.obligation_id != null ? { obligationId: input.intent.obligation_id } : {}),
      },
      evidence: resolvedEvidence,
      ...(agent.max_risk_level !== undefined ? { maxRiskLevel: agent.max_risk_level } : {}),
    });
    if (!evidenceResult.passed) {
      return failGate(9.5, "evidence_supports_action", { failures: evidenceResult.failures });
    }
    pass(checks, 9.5, "evidence_supports_action");
  } else {
    pass(checks, 9.5, "evidence_supports_action", { not_applicable: true });
  }

  // 10 — approval requirement determined (we have decision.outcome).
  pass(checks, 10, "approval_requirement_determined", { outcome: decision.outcome });

  // 11 — approval granted when required.
  if (decision.outcome === "confirm") {
    const approvals = await deps.resolveApprovals(input.intent.id);
    const signedSet = new Set(approvals.signedRoles);
    const missing = decision.required_approvers.filter((r) => !signedSet.has(r));
    if (missing.length > 0) {
      return failGate(11, "approval_granted_when_required", {
        required: decision.required_approvers,
        signed: approvals.signedRoles,
        missing,
      });
    }
  }
  pass(checks, 11, "approval_granted_when_required");

  // 11.5 — duplicate-payment guard (H-22). A collision is a HARD reject even
  // with approval present (the destination-change rule is the strongest single
  // fraud signal). DB-backed detector is injected; absent ⇒ not-applicable.
  if (deps.detectDuplicates !== undefined) {
    const dupResult = await deps.detectDuplicates({
      tenantId: input.ctx.tenantId,
      paymentIntent: {
        id: input.intent.id,
        counterpartyId: input.intent.destination_counterparty_id,
        amount: input.intent.amount,
        currency: input.intent.currency,
        ...(input.intent.invoice_id != null ? { invoiceId: input.intent.invoice_id } : {}),
        ...(input.intent.obligation_id != null ? { obligationId: input.intent.obligation_id } : {}),
        evidenceArtifactIds: input.intent.evidence_ids,
      },
    });
    if (!dupResult.passed) {
      return failGate(11.5, "no_duplicate_payment", { collisions: dupResult.collisions });
    }
    pass(checks, 11.5, "no_duplicate_payment");
  } else {
    pass(checks, 11.5, "no_duplicate_payment", { not_applicable: true });
  }

  // 12 — PolicyDecision row recorded. evaluatePolicy returned a stored
  // decision; surface its id.
  pass(checks, 12, "policy_decision_recorded", { policy_decision_id: decision.id });

  // 13 — audit-before emitted. The matching audit-after event is the caller's
  // responsibility AFTER the rail dispatches. Dry-run emits NOTHING (it only
  // computes); instead it may cache the trace for the subsequent live call.
  let auditBeforeEventId = "";
  if (dryRun) {
    pass(checks, 13, "audit_before_emitted", { dry_run: true });
    if (deps.traceCache !== undefined) {
      await deps.traceCache.set(gateTraceCacheKey(input.intent), trace, DRY_RUN_TRACE_TTL_SECONDS);
    }
  } else {
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
        ledger_state_hash: ledgerStateHash,
      },
      // H-07: persist the full §6 check trace (checks 1..12.x; check 13 is this
      // event's own existence) so the Proof API can reproduce a faithful,
      // tamper-evident gate trace from history. Snapshot with a copy so the
      // post-emit `pass(checks, 13, …)` below cannot mutate the stored trace.
      // Additive — no decision logic changes; the event hash commits to it too.
      outputs: { gate_passed: true, gate_checks: [...checks] },
      policyDecisionId: decision.id,
    });
    auditBeforeEventId = auditEvent.id;
    pass(checks, 13, "audit_before_emitted", { audit_event_id: auditEvent.id });
  }

  return {
    ok: true,
    dryRun,
    outcome: decision.outcome,
    requiredApprovers: decision.required_approvers,
    policyDecisionId: dryRun ? "" : decision.id,
    auditBeforeEventId,
    ledgerStateHash,
    trace,
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

/** Add two non-negative decimal strings (18 frac digits) without f64 loss. */
function addDecimalString(a: string, b: string): string {
  const na = norm(a);
  const nb = norm(b);
  const sum = BigInt(na.int + na.frac) + BigInt(nb.int + nb.frac);
  const abs = sum.toString().padStart(19, "0");
  const intPart = abs.slice(0, abs.length - 18).replace(/^0+/, "") || "0";
  const fracPart = abs.slice(abs.length - 18).replace(/0+$/, "");
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
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
