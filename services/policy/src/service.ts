/**
 * PolicyService — in-process evaluate hook for the §6 pre-execution gate.
 *
 * Loads the active policy for the tenant, runs the deterministic rule VM,
 * persists a policy_decisions row, emits an audit event, and returns a
 * GatePolicyDecision proof artifact.
 */

import { createHash } from "node:crypto";
import {
  brainError,
  brainId,
  ID_PREFIX,
  newPolicyDecisionId,
  withTenantScope,
  type AuditEmitter,
  type GatePaymentIntent,
  type GatePolicyDecision,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import { getActive } from "./repository.js";
import { evaluate, type Action } from "./vm.js";
import { incrementSpendCounter, readSpendWindow, readTxCountWindow } from "./spend-counters.js";
import type { ApplyTo, PolicyDocument, PolicyRule } from "./dsl.js";
import {
  applyReputationAdjustment,
  readReputationEnvelope,
  type ReputationResolver,
} from "./reputation.js";

export interface PolicyServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  /**
   * Optional ERC-8004 reputation source (RFC 0001 §7.7). When wired AND the
   * matched rule declares a reputation envelope, a low-reputation counterparty
   * TIGHTENS the decision (more approvers / lower caps) before the
   * policy_decisions proof row is written. Absent ⇒ no adjustment (status quo).
   * Reputation lives entirely in the policy layer; the §6 gate enforces the
   * resulting thresholds deterministically and never sees a reputation value.
   */
  resolveReputation?: ReputationResolver;
}

export class PolicyService {
  public constructor(private readonly deps: PolicyServiceDeps) {}

  public async evaluateLegacy(
    ctx: ServiceCallContext,
    raw: Record<string, unknown>,
  ): Promise<{
    outcome: "allow" | "confirm" | "reject";
    matched_rule_id: string | null;
    required_approvers: string[];
    trace: unknown[];
    policy_version: number;
  }> {
    const active = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => getActive(c));
    if (active === null) {
      throw brainError("policy_not_found", "no active policy for tenant");
    }

    const action: Action = {
      kind: typeof raw["kind"] === "string" ? (raw["kind"] as ApplyTo) : "outbound_payment",
      counterparty_id: typeof raw["counterparty_id"] === "string" ? raw["counterparty_id"] : null,
      amount: isAmountShape(raw["amount"])
        ? { currency: raw["amount"].currency, value: raw["amount"].value }
        : null,
      agent_role: typeof raw["agent_role"] === "string" ? raw["agent_role"] : null,
      agent_id: typeof raw["agent_id"] === "string" ? raw["agent_id"] : null,
      confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : null,
      evidence_score: typeof raw["evidence_score"] === "number" ? raw["evidence_score"] : null,
      risk_level: isRiskLevel(raw["risk_level"]) ? raw["risk_level"] : null,
      timestamp: new Date(),
    };

    const decision = evaluate(active.content, action);
    const snapshotHash = sha256Action(raw);
    const id = newPolicyDecisionId();

    await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      await c.query(
        `INSERT INTO policy_decisions
           (id, tenant_id, policy_id, policy_version, subject_type, subject_id,
            outcome, matched_rule_id, required_approvers, ledger_snapshot_hash, trace)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          ctx.tenantId,
          active.id,
          active.version,
          "agent_action",
          null,
          decision.outcome,
          decision.matched_rule_id,
          decision.required_approvers,
          snapshotHash,
          JSON.stringify(decision.trace),
        ],
      );
    });

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "policy",
      actor: ctx.actor,
      action: "policy.evaluate",
      inputs: {
        subject_type: "agent_action",
        action_kind: action.kind,
        policy_version: active.version,
      },
      outputs: {
        decision_id: id,
        outcome: decision.outcome,
        matched_rule_id: decision.matched_rule_id,
      },
    });

    return {
      outcome: decision.outcome,
      matched_rule_id: decision.matched_rule_id,
      required_approvers: decision.required_approvers,
      trace: decision.trace,
      policy_version: active.version,
    };
  }

  public async evaluateForGate(
    ctx: ServiceCallContext,
    intent: GatePaymentIntent,
  ): Promise<GatePolicyDecision> {
    const active = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => getActive(c));
    if (active === null) {
      throw brainError("policy_not_found", "no active policy for tenant");
    }

    // Load the agent's current spend/tx-count windows referenced by the policy
    // so the VM can evaluate the spend envelopes deterministically (1b.2). The
    // VM stays pure; this is the only I/O.
    const agentId = intent.created_by_agent_id;
    const spendWindows = collectSpendWindows(active.content);
    const txWindows = collectTxWindows(active.content);
    let spendInWindow: Record<string, { currency: string; value: string }> | undefined;
    let txCountInWindow: Record<string, number> | undefined;
    if (agentId !== null && (spendWindows.length > 0 || txWindows.length > 0)) {
      await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
        const s: Record<string, { currency: string; value: string }> = {};
        for (const w of spendWindows) {
          s[w.window] = {
            currency: w.currency,
            value: await readSpendWindow(c, {
              agentId,
              window: w.window,
              currency: w.currency,
            }),
          };
        }
        const t: Record<string, number> = {};
        for (const w of txWindows) {
          t[w] = await readTxCountWindow(c, { agentId, window: w });
        }
        spendInWindow = s;
        txCountInWindow = t;
      });
    }

    const action: Action = {
      kind: intentToApplyTo(intent.action_type),
      counterparty_id: intent.destination_counterparty_id,
      amount: { currency: intent.currency, value: intent.amount },
      agent_role: null,
      agent_id: agentId,
      // TODO(agent-autonomy-v3): resolve real tenant category (router defaults to
      // "business" today); thread the same source here for tenant.category rules.
      tenant_category: "business",
      timestamp: new Date(),
      // RFC 0004 §5.2: thread the intent's evidence confidence so a tenant
      // policy rule `agent.confidence.gte` becomes a live autonomy gate. The VM
      // fails closed when this is null, so an unset confidence never satisfies a
      // threshold rule.
      confidence: intent.confidence ?? null,
      evidence_score: intent.evidence_score ?? null,
      risk_level: isRiskLevel(intent.risk_level) ? intent.risk_level : null,
      ...(spendInWindow !== undefined ? { spend_in_window: spendInWindow } : {}),
      ...(txCountInWindow !== undefined ? { tx_count_in_window: txCountInWindow } : {}),
    };

    const decision = evaluate(active.content, action);

    const snapshotHash = sha256Intent(intent);
    const id = newPolicyDecisionId();
    const matchedRule =
      decision.matched_rule_id !== null ? findRule(active.content, decision.matched_rule_id) : null;

    // Base proof artifact from the deterministic VM.
    const base: GatePolicyDecision = {
      id,
      outcome: decision.outcome,
      matched_rule_id: decision.matched_rule_id,
      required_approvers: decision.required_approvers,
      ledger_snapshot_hash: snapshotHash,
      trace: decision.trace as unknown as Array<Record<string, unknown>>,
      required_evidence_kinds: [...(matchedRule?.required_evidence_kinds ?? [])],
      counterparty_verification_threshold: null,
      amount_upper_bound: matchedRule?.when["amount.lte"] ?? null,
      ...(matchedRule?.onchain_settlement_permitted !== undefined
        ? { onchain_settlement_permitted: matchedRule.onchain_settlement_permitted }
        : {}),
      x402_autonomous_max_amount: matchedRule?.x402_autonomous_max_amount ?? null,
      ach_autonomous_max_amount: matchedRule?.ach_autonomous_max_amount ?? null,
      card_autonomous_max_amount: matchedRule?.card_autonomous_max_amount ?? null,
      // P0.4: the active policy version, threaded to approval staleness checks.
      policy_version: active.version,
    };

    // Reputation (RFC 0001 §7.7): tighten the decision for a low-reputation
    // counterparty BEFORE persisting, so the policy_decisions proof row + audit
    // reflect the final thresholds the §6 gate will enforce. Tighten-only and
    // dormant when no source is wired or the rule declares no envelope. The §6
    // gate never sees a reputation value (Standards §6, Principle #5).
    const envelope = readReputationEnvelope(matchedRule);
    const final =
      this.deps.resolveReputation !== undefined && envelope !== undefined
        ? applyReputationAdjustment(
            base,
            await this.deps.resolveReputation(ctx, intent.destination_counterparty_id),
            envelope,
          )
        : base;

    await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      await c.query(
        `INSERT INTO policy_decisions
           (id, tenant_id, policy_id, policy_version, subject_type, subject_id,
            outcome, matched_rule_id, required_approvers, ledger_snapshot_hash, trace)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          ctx.tenantId,
          active.id,
          active.version,
          "payment_intent",
          intent.id,
          final.outcome,
          final.matched_rule_id,
          final.required_approvers,
          snapshotHash,
          JSON.stringify(final.trace),
        ],
      );
    });

    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "policy",
      actor: ctx.actor,
      action: "policy.evaluate",
      inputs: {
        subject_type: "payment_intent",
        subject_id: intent.id,
        action_kind: action.kind,
        policy_version: active.version,
      },
      outputs: {
        decision_id: id,
        outcome: final.outcome,
        matched_rule_id: final.matched_rule_id,
        reputation_adjusted: final !== base,
      },
    });

    return final;
  }

  /**
   * Accumulate the agent's spend + tx-count counters for the windows the active
   * policy references (R-21). The reader side (`agent.spend_in_window` /
   * `agent.tx_count_in_window` in {@link evaluateForGate}) already existed; this
   * is the writer that was never wired, so aggregate caps used to read a
   * counter that stayed 0 forever.
   *
   * Runs on the CALLER's tenant-scoped client (PaymentIntentService.completeExecution),
   * so the increment commits in the SAME transaction as the intent reaching
   * `executed` — a settle records spend and advances state together, or rolls
   * back together. Bumps one bucket per referenced window using the intent's
   * own currency + amount (each `incrementSpendCounter` adds the amount and one
   * tx to that window's bucket). The VM compares the cap fail-closed when the
   * action currency differs from the cap currency, so tracking spend under the
   * intent's actual currency stays consistent with what the reader reads back.
   *
   * No-op when the tenant has no active policy or the policy declares no spend /
   * tx windows (so counters stay empty for tenants that don't use aggregate caps).
   */
  /**
   * The tenant's active signed PolicyDocument, or null when none is active.
   * Read-only accessor used by the agent-router's H-23 action allowlist
   * (`allowedActionsFor`) so the resolver enforces the REQUESTING tenant's
   * signed `agent_actions` per call.
   */
  public async getActiveDocument(ctx: ServiceCallContext): Promise<PolicyDocument | null> {
    const active = await withTenantScope(this.deps.pool, ctx.tenantId, (c) => getActive(c));
    return active === null ? null : active.content;
  }

  public async recordAgentSpend(
    client: TenantScopedClient,
    input: { tenantId: string; agentId: string; amount: string; currency: string },
  ): Promise<void> {
    const active = await getActive(client);
    if (active === null) {
      return;
    }
    const windows = new Set<string>();
    for (const w of collectSpendWindows(active.content)) {
      windows.add(w.window);
    }
    for (const w of collectTxWindows(active.content)) {
      windows.add(w);
    }
    for (const window of windows) {
      await incrementSpendCounter(client, {
        id: brainId(ID_PREFIX.policySpendCounter),
        tenantId: input.tenantId,
        agentId: input.agentId,
        window,
        currency: input.currency,
        amount: input.amount,
      });
    }
  }
}

function isAmountShape(v: unknown): v is { currency: string; value: string } {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["currency"] === "string" && typeof o["value"] === "string";
}

function isRiskLevel(v: unknown): v is NonNullable<Action["risk_level"]> {
  return v === "low" || v === "medium" || v === "high" || v === "critical";
}

function sha256Action(action: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

function intentToApplyTo(actionType: string): ApplyTo {
  if (actionType === "ach_inbound") return "inbound_payment";
  if (actionType === "onchain_transfer") return "onchain_tx";
  return "outbound_payment";
}

function sha256Intent(intent: GatePaymentIntent): string {
  const payload = JSON.stringify({
    id: intent.id,
    amount: intent.amount,
    currency: intent.currency,
    source_account_id: intent.source_account_id,
    destination_counterparty_id: intent.destination_counterparty_id,
    evidence_ids: [...intent.evidence_ids].sort(),
    confidence: intent.confidence ?? null,
    evidence_score: intent.evidence_score ?? null,
    risk_level: intent.risk_level ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function findRule(policy: PolicyDocument, ruleId: string): PolicyRule | null {
  return policy.rules.find((r) => r.id === ruleId) ?? null;
}

/** Distinct (window,currency) pairs the policy's spend envelopes reference (1b.2). */
function collectSpendWindows(doc: PolicyDocument): Array<{ window: string; currency: string }> {
  const seen = new Set<string>();
  const out: Array<{ window: string; currency: string }> = [];
  for (const rule of doc.rules) {
    const c = rule.when["agent.spend_in_window"];
    if (c === undefined) continue;
    const key = `${c.window}:${c.lte.currency}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ window: c.window, currency: c.lte.currency });
    }
  }
  return out;
}

/** Distinct windows the policy's tx-count envelopes reference (1b.2). */
function collectTxWindows(doc: PolicyDocument): string[] {
  const seen = new Set<string>();
  for (const rule of doc.rules) {
    const c = rule.when["agent.tx_count_in_window"];
    if (c !== undefined) seen.add(c.window);
  }
  return [...seen];
}
