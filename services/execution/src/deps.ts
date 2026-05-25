import type {
  AuditEmitter,
  GateAccount,
  GateAgent,
  GateCounterparty,
  GatePaymentIntent,
  GatePolicyDecision,
  GatePrincipal,
  GateTenantFlags,
  ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import type { RailRegistry } from "./rails/stubs.js";

export interface ExecutionDeps {
  pool: Pool;
  audit: AuditEmitter;
  rails: RailRegistry;

  /**
   * Stage-6 evaluatePolicy hook (used by the legacy /execution/propose
   * route). Phase 4 retains the field for back-compat. The richer
   * evaluatePaymentIntent below is what the §6 gate consumes.
   */
  evaluatePolicy: (
    tenantId: string,
    action: Record<string, unknown>,
  ) => Promise<{
    outcome: "allow" | "confirm" | "reject";
    matched_rule_id: string | null;
    required_approvers: string[];
    trace: unknown[];
    policy_version: number;
  }>;

  // -- Phase 4 hooks --------------------------------------------------

  /** §6 gate evaluator. Returns the rich PolicyDecision shape. */
  evaluatePaymentIntent: (
    ctx: ServiceCallContext,
    intent: GatePaymentIntent,
  ) => Promise<GatePolicyDecision>;

  /** Resolve agent record for §6 check 1. */
  resolveAgent: (ctx: ServiceCallContext, agentId: string) => Promise<GateAgent | null>;

  /**
   * Resolve per-tenant gate-enforcement flags for §6 check 1.5 (P0.1). Optional:
   * when absent the gate keeps its pre-P0.1 behavior-hash behavior (verify only
   * when both hashes are present).
   */
  resolveTenantFlags?: (ctx: ServiceCallContext, tenantId: string) => Promise<GateTenantFlags>;

  /** Resolve source account for §6 check 4 + 8. */
  resolveAccount: (ctx: ServiceCallContext, accountId: string) => Promise<GateAccount | null>;

  /** Resolve counterparty for §6 checks 5 + 6. */
  resolveCounterparty: (
    ctx: ServiceCallContext,
    counterpartyId: string,
  ) => Promise<GateCounterparty | null>;

  /** Map ServiceCallContext to a GatePrincipal (pulls from JWT). */
  resolvePrincipal: (ctx: ServiceCallContext) => Promise<GatePrincipal>;

  /** Maps a principal id to a role name (for ApprovalService). Caller-supplied. */
  resolveRole: (ctx: ServiceCallContext, principalId: string) => Promise<string | null>;

  // -- P0.4 approver/quorum hardening hooks (optional; wired in main.ts) -----

  /** True iff the signer principal is an active (non-revoked) approver. */
  isApproverActive?: (ctx: ServiceCallContext, principalId: string) => Promise<boolean>;
  /** Owning tenant of an approval subject (intent/proposal) — cross-tenant guard. */
  resolveSubjectOwnerTenant?: (
    ctx: ServiceCallContext,
    subject: { type: "payment_intent" | "proposal"; id: string },
  ) => Promise<string | null>;
  /** Tenant's currently-active policy version — recorded on each signature. */
  resolveActivePolicyVersion?: (ctx: ServiceCallContext) => Promise<number | null>;
}
