/**
 * Mapper: storage PaymentIntent → wire Action.
 *
 * The v0.3 docs publish an `Action` resource at /v1/actions/*. Internally
 * we keep using the existing PaymentIntent storage row + service to
 * minimize blast radius — see docs/sdk-audit.md decision A. This file is
 * the translation boundary:
 *
 *   - status:   PaymentIntent (proposed | pending_approval | approved
 *                | rejected | executed | failed | cancelled)
 *               → ActionStatus (auto | needs_approval | approved
 *                | rejected | executed | failed | cancelled)
 *   - decision: derived from status (we don't fetch the underlying
 *               PolicyDecision row here; status carries enough signal)
 *
 *   - "auto" semantics: action is policy-permitted and either already
 *     executed or queued for execution without further human input.
 *     Currently we emit "auto" for `proposed` and `approved` (both
 *     "ready to run"). `executed` stays distinct (it has run).
 */

import type { ExecutionMode, PaymentIntent, PaymentIntentStatus } from "@brain/shared";
import { resolveExecutionMode } from "@brain/shared";

export type ActionStatus =
  | "auto"
  | "needs_approval"
  | "approved"
  | "paused"
  | "dispatching"
  | "rejected"
  | "executed"
  | "failed"
  | "cancelled";

export type ActionDecision = "ALLOW" | "ESCALATE" | "DENY";

export interface Action {
  readonly id: string;
  readonly tenantId: string;
  readonly agent_id: string | null;
  readonly type: string;
  readonly decision: ActionDecision;
  readonly status: ActionStatus;
  readonly approvers: readonly string[];
  readonly approvals: readonly unknown[];
  readonly rail: string | null;
  readonly tx_hash: string | null;
  readonly rail_receipt: Readonly<Record<string, unknown>> | null;
  readonly executed_at: string | null;
  readonly settled_at: string | null;
  readonly expires_at: string;
  readonly policy_version: number | null;
  readonly matched_rule: string | null;
  readonly reason: Readonly<Record<string, unknown>> | null;
  readonly signed_verdict: string | null;
  // Additive decision refinement (Phase 1). `decision` above stays the
  // authoritative ALLOW | ESCALATE | DENY verdict; these fold in the
  // proposing agent's confidence + evidence + risk. Backward compatible —
  // existing callers reading `decision` are unaffected.
  readonly confidence: number;
  readonly evidence_score: number;
  readonly execution_mode: ExecutionMode;
  readonly audit_events: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export function piStatusToActionStatus(s: PaymentIntentStatus): ActionStatus {
  switch (s) {
    case "proposed":
    case "approved":
      // Both mean "policy-permitted, ready to execute". Docs collapse
      // these into "auto".
      return "auto";
    case "pending_approval":
      return "needs_approval";
    case "paused":
      // Kill-switch hold (1b.3): surfaced 1:1 so the actions view reflects it.
      return "paused";
    case "dispatching":
      // H-04: gate passed, handed to the durable outbox, rail not yet settled.
      return "dispatching";
    case "rejected":
      return "rejected";
    case "executed":
      return "executed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/**
 * Derive the docs-vocabulary decision from the PaymentIntent's lifecycle
 * status. We avoid a second DB fetch by leaning on the fact that the
 * service already encoded the policy verdict into the status enum at
 * create time:
 *
 *   - rejected         ←  decision = DENY
 *   - pending_approval ←  decision = ESCALATE (policy required signers)
 *   - everything else  ←  decision = ALLOW
 *     (proposed/approved/executed/failed/cancelled all imply policy
 *     permitted the action to continue at some point in its lifecycle)
 */
export function piStatusToDecision(s: PaymentIntentStatus): ActionDecision {
  switch (s) {
    case "rejected":
      return "DENY";
    case "pending_approval":
      return "ESCALATE";
    default:
      return "ALLOW";
  }
}

/**
 * Default decision-validity window. Tracks the policy version so a
 * stale decision can be re-evaluated. v0.3: hardcoded 24h from now.
 * Stage-9: derive from the policy's `expires_in` clause when it lands.
 */
function defaultExpiresAt(updatedAt: string): string {
  const base = new Date(updatedAt).getTime();
  return new Date(base + 24 * 3600 * 1000).toISOString();
}

export function paymentIntentToAction(pi: PaymentIntent): Action {
  const decision = piStatusToDecision(pi.status);
  // Legacy PaymentIntent rows carry no agent confidence/evidence signal, so
  // we use conservative defaults: full confidence + complete evidence, but
  // risk "medium" so a bare ALLOW never auto-"execute"s here — it maps to
  // "propose". Agent-proposed actions (router/handlers) pass real values.
  const execution_mode = resolveExecutionMode({
    decision,
    confidence: 1,
    evidenceComplete: true,
    minimumConfidence: 0,
    riskLevel: "medium",
  });
  return {
    id: pi.id,
    tenantId: pi.owner_id,
    agent_id: pi.created_by_agent_id,
    type: pi.action_type,
    decision,
    status: piStatusToActionStatus(pi.status),
    approvers: [],
    approvals: [],
    rail: null,
    tx_hash: null,
    rail_receipt: null,
    executed_at: null,
    settled_at: null,
    expires_at: defaultExpiresAt(pi.updated_at ?? pi.created_at),
    policy_version: null,
    matched_rule: null,
    reason: null,
    signed_verdict: null,
    confidence: 1,
    evidence_score: 1,
    execution_mode,
    audit_events: [],
    created_at: pi.created_at,
    updated_at: pi.updated_at,
  };
}
