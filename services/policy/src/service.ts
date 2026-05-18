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
  newPolicyDecisionId,
  withTenantScope,
  type AuditEmitter,
  type GatePaymentIntent,
  type GatePolicyDecision,
  type ServiceCallContext,
} from "@brain/api/shared";
import type { Pool } from "pg";
import { getActive } from "./repository.js";
import { evaluate, type Action } from "./vm.js";
import type { ApplyTo, PolicyDocument, PolicyRule } from "./dsl.js";

export interface PolicyServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
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

    const action: Action = {
      kind: intentToApplyTo(intent.action_type),
      counterparty_id: intent.destination_counterparty_id,
      amount: { currency: intent.currency, value: intent.amount },
      agent_role: null,
      timestamp: new Date(),
    };

    const decision = evaluate(active.content, action);

    const snapshotHash = sha256Intent(intent);
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
          "payment_intent",
          intent.id,
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
        subject_type: "payment_intent",
        subject_id: intent.id,
        action_kind: action.kind,
        policy_version: active.version,
      },
      outputs: {
        decision_id: id,
        outcome: decision.outcome,
        matched_rule_id: decision.matched_rule_id,
      },
    });

    const matchedRule =
      decision.matched_rule_id !== null ? findRule(active.content, decision.matched_rule_id) : null;

    return {
      id,
      outcome: decision.outcome,
      matched_rule_id: decision.matched_rule_id,
      required_approvers: decision.required_approvers,
      ledger_snapshot_hash: snapshotHash,
      trace: decision.trace as unknown as Array<Record<string, unknown>>,
      required_evidence_kinds: [],
      counterparty_verification_threshold: null,
      amount_upper_bound: matchedRule?.when["amount.lte"] ?? null,
    };
  }
}

function isAmountShape(v: unknown): v is { currency: string; value: string } {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["currency"] === "string" && typeof o["value"] === "string";
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
  });
  return createHash("sha256").update(payload).digest("hex");
}

function findRule(policy: PolicyDocument, ruleId: string): PolicyRule | null {
  return policy.rules.find((r) => r.id === ruleId) ?? null;
}
