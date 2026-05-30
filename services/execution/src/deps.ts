import type {
  AgentAttestationInput,
  AgentAttestationResult,
  AuditEmitter,
  DuplicateCheckInput,
  DuplicateCheckResult,
  EscrowStateInput,
  GateAccount,
  GateAgent,
  GateCounterparty,
  GatePaymentIntent,
  GatePolicyDecision,
  GatePrincipal,
  GateTenantFlags,
  MetricsEmitter,
  ResolvedEscrowState,
  ResolvedEvidence,
  ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import type { RailRegistry } from "./rails/stubs.js";
import type { ResolvedInvoiceShortcut } from "./payment-intents/invoice-shortcut.js";

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

  /** P0.5: resolves the `pay_invoice` create shortcut into a full payload. */
  resolveInvoiceShortcut?: (
    ctx: ServiceCallContext,
    invoiceId: string,
  ) => Promise<ResolvedInvoiceShortcut>;

  // -- §6 M2M gate loaders (composition-root parity with api/main.ts) -----
  // These must match the loaders wired in services/api/src/main.ts:922-937
  // so the standalone execution server's §6 gate enforces checks 5.5 / 8.5 /
  // 6.6 the same way the all-in-one api boot does. Without them, those checks
  // record `not_applicable` and the M2M attack surface degrades silently.
  // scripts/check-payment-intent-loaders.mjs enforces that every production
  // PaymentIntentService construction site injects the required loaders.

  /** RFC 0001 §6.3 — agent payee attestation read (check 5.5). */
  attestCounterpartyAgent?: (
    ctx: ServiceCallContext,
    input: AgentAttestationInput,
  ) => Promise<AgentAttestationResult>;
  /** RFC 0001 §6.4 — rolling-window per-agent spend (check 8.5). */
  sumAgentWindowSpend?: (
    ctx: ServiceCallContext,
    agentId: string,
    windowSeconds: number,
  ) => Promise<string>;
  /** RFC 0001 §7.6 — on-chain escrow lock state (check 6.6). */
  resolveEscrowState?: (
    ctx: ServiceCallContext,
    input: EscrowStateInput,
  ) => Promise<ResolvedEscrowState | null>;

  // -- Core safety loaders (§6 gate checks 8 / 9.5 / 11.5) -----------------
  // Mandatory in production. When absent the gate degrades to `not_applicable`
  // for the corresponding check (acceptable for dev/test only). The
  // composition-root parity lint (scripts/check-payment-intent-loaders.mjs)
  // requires every production root to thread all three.

  /** §6 check 8 — sum of active reservations on the source account. */
  sumActiveReservations?: (ctx: ServiceCallContext, accountId: string) => Promise<string>;
  /** §6 check 9.5 (H-21) — semantic evidence validation against policy. */
  resolveEvidence?: (
    ctx: ServiceCallContext,
    intent: GatePaymentIntent,
  ) => Promise<ResolvedEvidence[]>;
  /** §6 check 11.5 (H-22) — duplicate-payment / fraud-pattern detector. */
  detectDuplicates?: (
    ctx: ServiceCallContext,
    input: DuplicateCheckInput,
  ) => Promise<DuplicateCheckResult>;

  /** Item 11 — §6 gate metrics emission (per-check, outcome, duration). */
  metrics?: MetricsEmitter;
}
