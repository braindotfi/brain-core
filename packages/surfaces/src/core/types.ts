import type { SurfaceName } from "./ports.js";

/** Where a proposal should be delivered on a given surface. */
export interface DeliveryTarget {
  surface: SurfaceName;
  /**
   * Surface-native destination. Slack: channel id or user id. Teams: conversation
   * reference id. Email: recipient address. The adapter interprets this.
   */
  to: string;
}

/** Result of dispatching one proposal to one target. */
export interface DeliveryResult {
  surface: SurfaceName;
  target: string;
  ok: boolean;
  /** Surface-native handle for the delivered message, used to update it later. */
  ref?: string | undefined;
  error?: string | undefined;
}

/**
 * A decision arriving from a surface (a Slack button click, a Teams card action,
 * an email link). Normalized so the approval flow is identical across surfaces.
 */
export interface IncomingDecision {
  surface: SurfaceName;
  proposalId: string;
  tenantId: string;
  /** The surface-native identity of whoever acted. */
  externalActorId: string;
  decision: "approved" | "rejected";
  /** Surface context for the audit trail. */
  context?: Record<string, string> | undefined;
}
