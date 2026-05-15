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

import type {
  PaymentIntent,
  PaymentIntentStatus,
} from "@brain/api/shared";

export type ActionStatus =
  | "auto"
  | "needs_approval"
  | "approved"
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
  return {
    id: pi.id,
    tenantId: pi.owner_id,
    agent_id: pi.created_by_agent_id,
    type: pi.action_type,
    decision: piStatusToDecision(pi.status),
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
    audit_events: [],
    created_at: pi.created_at,
    updated_at: pi.updated_at,
  };
}
