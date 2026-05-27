/**
 * ERC-8004 reputation as a Policy threshold input (RFC 0001 §7.7, Phase 4).
 *
 * Reputation feeds the POLICY layer as a *threshold* input — it can make a policy
 * decision STRICTER for a low-reputation counterparty (more approvers, a lower
 * amount cap, verification at a lower amount). It is consumed ENTIRELY inside the
 * policy evaluation: the resulting (already-adjusted) thresholds are what the §6
 * pre-execution gate enforces, deterministically. The gate never sees a
 * reputation value — reputation is NEVER a §6 precondition (Standards §6,
 * Principle #5: LLM/reputation judgment never replaces a deterministic gate
 * check).
 *
 * SAFETY — tighten-only. `applyReputationAdjustment` can only ADD approvers and
 * LOWER caps; it can never remove an approver, raise a cap, relax verification,
 * or turn a reject into an allow. A high (or absent, or gamed-high) reputation
 * therefore can never WEAKEN a control — at best it leaves the base policy
 * decision unchanged. Reputation-based *relaxation* is deliberately NOT
 * implemented.
 *
 * Hash-only (RFC 0001 §3): the on-chain ERC-8004 artifact is a pointer / Merkle
 * root, never raw history. `ReputationScore.source` carries that opaque pointer;
 * the numeric `score` is derived off-chain. The concrete on-chain reader is the
 * deferred live-wiring step (injected via `ReputationResolver`).
 */

import type { GatePolicyDecision, ServiceCallContext } from "@brain/shared";
import { compareDecimal } from "./vm.js";

/** A counterparty/agent reputation score (ERC-8004). `score` ∈ [0,1], higher = better. */
export interface ReputationScore {
  /** Normalized reputation in [0,1]; higher is more reputable. */
  readonly score: number;
  /** Opaque on-chain pointer / Merkle root the score was derived from (hash-only). */
  readonly source?: string;
}

/**
 * Resolves a counterparty's reputation. Injected (the policy service stays pure
 * of the chain). Returns null when no reputation is known ⇒ no adjustment. The
 * concrete reader (the on-chain ERC-8004 registry pointer) is deferred wiring.
 */
export type ReputationResolver = (
  ctx: ServiceCallContext,
  counterpartyId: string,
) => Promise<ReputationScore | null>;

/** A decimal money bound (mirrors GatePolicyDecision's bound shape). */
interface Bound {
  readonly currency: string;
  readonly value: string;
}

/**
 * Per-rule reputation envelope: when a counterparty's reputation is BELOW
 * `min_score`, the policy decision is tightened by `below`. Declared on a policy
 * rule. (DSL formalization is a follow-up; until then the envelope is read
 * defensively via {@link readReputationEnvelope}.)
 */
export interface ReputationEnvelope {
  /** Below this score the `below` tightening applies; at/above it, no change. */
  readonly min_score: number;
  readonly below?: {
    /** Roles unioned into required_approvers (escalates allow → confirm). */
    readonly add_approvers?: readonly string[];
    /** Cap applied as min(base, cap) — lowers or imposes an amount upper bound. */
    readonly amount_cap?: Bound;
    /** Require counterparty verification at/above this (lower) amount. */
    readonly require_verification_above?: Bound;
  };
}

/**
 * Deterministically tighten a policy decision based on reputation. PURE (no I/O).
 *
 * Returns `decision` UNCHANGED when: reputation is null, no envelope, the score
 * is at/above `min_score`, or no `below` adjustments apply. Otherwise it returns
 * a new decision that is strictly tighter (⊇ approvers, ≤ caps). Never loosens.
 */
export function applyReputationAdjustment(
  decision: GatePolicyDecision,
  reputation: ReputationScore | null,
  envelope: ReputationEnvelope | undefined,
): GatePolicyDecision {
  if (reputation === null || envelope === undefined) return decision;
  if (reputation.score >= envelope.min_score) return decision;
  const below = envelope.below;
  if (below === undefined) return decision;

  const applied: string[] = [];
  let outcome = decision.outcome;
  let requiredApprovers = decision.required_approvers;
  let amountUpperBound = decision.amount_upper_bound ?? null;
  let verificationThreshold = decision.counterparty_verification_threshold ?? null;

  // 1) Extra approvers — union only (never removes). If this makes the approver
  //    set non-empty and the base allowed outright, escalate allow → confirm so
  //    the §6 gate (checks 10/11) enforces the approval. A reject stays a reject.
  if (below.add_approvers !== undefined && below.add_approvers.length > 0) {
    const set = new Set(requiredApprovers);
    const sizeBefore = set.size;
    for (const role of below.add_approvers) set.add(role);
    if (set.size !== sizeBefore) {
      requiredApprovers = [...set];
      applied.push("add_approvers");
    }
    if (requiredApprovers.length > 0 && outcome === "allow") {
      outcome = "confirm";
      applied.push("escalate_allow_to_confirm");
    }
  }

  // 2) Amount cap — min(base, cap); imposes a cap where none existed. Tightens.
  if (below.amount_cap !== undefined) {
    const cap = below.amount_cap;
    if (amountUpperBound === null) {
      amountUpperBound = { currency: cap.currency, value: cap.value };
      applied.push("amount_cap_imposed");
    } else if (
      amountUpperBound.currency === cap.currency &&
      compareDecimal(cap.value, amountUpperBound.value) < 0
    ) {
      amountUpperBound = { currency: cap.currency, value: cap.value };
      applied.push("amount_cap_lowered");
    }
  }

  // 3) Counterparty verification at a LOWER amount — min(base, this). Tightens.
  if (below.require_verification_above !== undefined) {
    const v = below.require_verification_above;
    if (verificationThreshold === null) {
      verificationThreshold = { currency: v.currency, value: v.value };
      applied.push("verification_imposed");
    } else if (
      verificationThreshold.currency === v.currency &&
      compareDecimal(v.value, verificationThreshold.value) < 0
    ) {
      verificationThreshold = { currency: v.currency, value: v.value };
      applied.push("verification_lowered");
    }
  }

  if (applied.length === 0) return decision;

  return {
    ...decision,
    outcome,
    required_approvers: requiredApprovers,
    amount_upper_bound: amountUpperBound,
    counterparty_verification_threshold: verificationThreshold,
    // Append to the policy trace so the proof records the reputation adjustment.
    trace: [
      ...decision.trace,
      {
        reputation_adjustment: {
          score: reputation.score,
          min_score: envelope.min_score,
          ...(reputation.source !== undefined ? { source: reputation.source } : {}),
          applied,
        },
      },
    ],
  };
}

/**
 * Defensively read a {@link ReputationEnvelope} off a policy rule without
 * requiring the DSL type to carry it yet (DSL formalization is a follow-up).
 * Returns undefined unless `rule.reputation` is a well-formed envelope.
 */
export function readReputationEnvelope(rule: unknown): ReputationEnvelope | undefined {
  if (rule === null || typeof rule !== "object") return undefined;
  const rep = (rule as { reputation?: unknown }).reputation;
  if (rep === null || typeof rep !== "object") return undefined;
  const minScore = (rep as { min_score?: unknown }).min_score;
  if (typeof minScore !== "number") return undefined;
  const belowRaw = (rep as { below?: unknown }).below;
  let below: ReputationEnvelope["below"];
  if (belowRaw !== null && typeof belowRaw === "object") {
    const b = belowRaw as Record<string, unknown>;
    below = {
      ...(Array.isArray(b["add_approvers"])
        ? { add_approvers: (b["add_approvers"] as unknown[]).filter((x) => typeof x === "string") }
        : {}),
      ...(isBound(b["amount_cap"]) ? { amount_cap: b["amount_cap"] } : {}),
      ...(isBound(b["require_verification_above"])
        ? { require_verification_above: b["require_verification_above"] }
        : {}),
    };
  }
  return below !== undefined ? { min_score: minScore, below } : { min_score: minScore };
}

function isBound(v: unknown): v is Bound {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["currency"] === "string" && typeof o["value"] === "string";
}
