import { z } from "zod";

/**
 * The canonical Brain proposal.
 *
 * This is the single object every agent emits and every surface renders.
 * Slack, Teams, and email are dumb renderers over this shape. Add a surface
 * by writing an adapter, never by changing the schema. Add an agent by writing
 * a proposal factory, never by teaching a surface about a new agent.
 *
 * Agents are propose-only. A proposal never bypasses approval. When a proposal
 * has a canonical executionTarget, an accepted human decision advances that
 * PaymentIntent through core's normal gate and durable execution outbox.
 */

// Branded ids prevent mixing a tenant id with a proposal id at compile time.
type Brand<T, B extends string> = T & { readonly __brand: B };
export type TenantId = Brand<string, "TenantId">;
export type ProposalId = Brand<string, "ProposalId">;
export type ActorId = Brand<string, "ActorId">;

export const toTenantId = (s: string): TenantId => s as TenantId;
export const toProposalId = (s: string): ProposalId => s as ProposalId;
export const toActorId = (s: string): ActorId => s as ActorId;

/** The four public agents. Source of truth for the agent enum. */
export const AGENT_KINDS = ["invoice", "collections", "cash", "close"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Decision states. Execution remains a separate gated core transition. */
export const DECISIONS = ["pending", "approved", "rejected", "expired"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Severity drives surface treatment, for example DM versus channel post. */
export const SEVERITIES = ["info", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * One line of evidence behind a claim. Kept generic so every agent can attach
 * its own supporting facts without the schema needing per-agent fields.
 */
export const EvidenceItemSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  /** Optional deep link back into the source system, for example the ERP bill. */
  href: z.string().url().optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/**
 * The recommended action shown to the approver. `handoff` and `payload` remain
 * presentation metadata. Execution uses only the typed executionTarget and the
 * canonical PaymentIntent stored by core.
 */
export const RecommendedActionSchema = z.object({
  summary: z.string().min(1),
  /** For example "netsuite", "quickbooks", "bank-portal", "email-send". */
  handoff: z.string().min(1),
  /** Display metadata only. Never used as executable input by the gateway. */
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Display-only monetary impact, for example recovered or at-risk amount. */
  amount: z.object({ currency: z.string().length(3), minorUnits: z.number().int() }).optional(),
});
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

/**
 * Canonical core action that an accepted surface approval is allowed to
 * advance. Historic notification-only cards have no reference and therefore
 * fail closed on approval instead of claiming that an opaque handoff ran.
 */
export const SurfaceExecutionTargetSchema = z.object({
  type: z.literal("payment_intent"),
  id: z.string().regex(/^pi_[A-Za-z0-9]+$/),
});
export type SurfaceExecutionTarget = z.infer<typeof SurfaceExecutionTargetSchema>;

export const PAYEE_KINDS = ["vendor", "employee", "payroll", "other"] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

export const PayeeSchema = z.object({
  kind: z.enum(PAYEE_KINDS),
  email: z.string().email().optional(),
  counterpartyId: z.string().min(1).optional(),
});
export type Payee = z.infer<typeof PayeeSchema>;

/**
 * The result of running the proposal through the brain-core Policy layer.
 * Captured on the proposal so the surface can show who is allowed to approve
 * and so the audit record proves the gate ran.
 */
export const PolicyResultSchema = z.object({
  /** Policy gate ids that evaluated, for example ["AP-DUP-001", "ROLE-APPROVE"]. */
  gates: z.array(z.string()),
  /** Roles permitted to approve this specific proposal. */
  approverRoles: z.array(z.string()).min(1),
  /** Whether policy requires more than one approver. */
  requiresDualApproval: z.boolean().default(false),
});
export type PolicyResult = z.infer<typeof PolicyResultSchema>;

export const ProposalDomainDecisionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  meaning: z.string().min(1),
});
export type ProposalDomainDecision = z.infer<typeof ProposalDomainDecisionSchema>;

export const ProposalDecisionContextSchema = z.object({
  decide_by: z.string().min(1),
  if_wrong: z.string().min(1),
  reversible: z.object({
    state: z.enum(["yes", "no", "na"]),
    label: z.string().min(1),
  }),
});
export type ProposalDecisionContext = z.infer<typeof ProposalDecisionContextSchema>;

const BankComparisonEntrySchema = z.object({
  bank_name: z.string().optional(),
  routing_masked: z.string().optional(),
  account_masked: z.string().optional(),
  beneficiary: z.string().optional(),
});

export const ProposalRailFieldsSchema = z
  .object({
    decision_context: ProposalDecisionContextSchema.optional(),
    signals: z
      .object({
        geo_mismatch: z
          .object({
            normal_regions: z.array(z.string()),
            observed_region: z.string(),
          })
          .optional(),
        off_hours: z
          .object({
            typical_window: z.string(),
            observed_hour: z.string(),
          })
          .optional(),
        normal_vs_current: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    comparison: z
      .object({
        bank_on_file: BankComparisonEntrySchema.optional(),
        bank_on_invoice: BankComparisonEntrySchema.optional(),
        quantity_a: z.unknown().optional(),
        quantity_b: z.unknown().optional(),
        po_ref_a: z.string().optional(),
        po_ref_b: z.string().optional(),
      })
      .optional(),
    draft_email: z
      .object({
        to: z.string(),
        from: z.string(),
        subject: z.string(),
        body: z.array(z.string()),
        edit_actions: z.array(z.string()),
      })
      .optional(),
    cash_impact: z
      .object({
        source_account_id: z.string(),
        balance_before: z.number(),
        balance_after: z.number(),
      })
      .optional(),
    historical_win_rate: z
      .object({
        pct: z.number(),
        sample_size: z.number().int(),
        time_window: z.string(),
      })
      .optional(),
    allocation_before: z.record(z.string(), z.unknown()).optional(),
    allocation_after: z.record(z.string(), z.unknown()).optional(),
    safety_meter: z.record(z.string(), z.unknown()).optional(),
    estimated_annual_yield_gain: z.record(z.string(), z.unknown()).optional(),
    close_aggregate: z.record(z.string(), z.unknown()).optional(),
    accountant: z
      .object({
        name: z.string(),
        org: z.string(),
        email: z.string(),
      })
      .optional(),
    materiality: z
      .object({
        unmatched_amount: z.number(),
        monthly_revenue: z.number(),
        pct: z.number(),
      })
      .optional(),
    horizon_days: z.number().int().optional(),
    drivers: z.array(z.record(z.string(), z.unknown())).optional(),
    runway_projection: z.array(z.record(z.string(), z.unknown())).optional(),
    concentration: z.record(z.string(), z.unknown()).optional(),
    historical_concentration: z.array(z.record(z.string(), z.unknown())).optional(),
    pipeline_coverage: z.record(z.string(), z.unknown()).optional(),
    alternatives: z
      .array(z.object({ name: z.string(), note: z.string(), price: z.string() }))
      .optional(),
    flagged_invoice: z.record(z.string(), z.unknown()).optional(),
    suspected_original: z.record(z.string(), z.unknown()).optional(),
    match_confidence: z.record(z.string(), z.unknown()).optional(),
    finding_kind: z.string().optional(),
    screenings: z.record(z.string(), z.unknown()).optional(),
    required_documents: z.array(z.unknown()).optional(),
    regulatory_context: z.record(z.string(), z.unknown()).optional(),
    jurisdictions_involved: z.array(z.string()).optional(),
    deadline: z.string().optional(),
    seats: z.record(z.string(), z.unknown()).optional(),
    underutilization: z.record(z.string(), z.unknown()).optional(),
    options: z.array(z.record(z.string(), z.unknown())).optional(),
    decisions: z.array(ProposalDomainDecisionSchema).optional(),
  })
  .partial();
export type ProposalRailFields = z.infer<typeof ProposalRailFieldsSchema>;

export const ProposalSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  agent: z.enum(AGENT_KINDS),
  severity: z.enum(SEVERITIES).default("warning"),
  /** Short headline rendered as the card title. */
  title: z.string().min(1),
  /** One paragraph in plain language. No jargon. */
  claim: z.string().min(1),
  evidence: z.array(EvidenceItemSchema).default([]),
  action: RecommendedActionSchema,
  executionTarget: SurfaceExecutionTargetSchema.optional(),
  payee: PayeeSchema.optional(),
  policy: PolicyResultSchema,
  inbox: ProposalRailFieldsSchema.optional(),
  /** ISO timestamp. After this the proposal auto expires and cannot be approved. */
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  /**
   * Deterministic hash of the rendered-relevant fields. Anchored in Audit so we
   * can later prove exactly what the human saw when they approved. Filled by
   * proposal/hash.ts, never by hand.
   */
  contentHash: z.string().optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** Parse and validate untrusted input into a Proposal, throwing on any drift. */
export function parseProposal(input: unknown): Proposal {
  return ProposalSchema.parse(input);
}
