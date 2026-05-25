/**
 * Brain Policy DSL.
 *
 * §3 Layer 3 MVP primitive set:
 *   applies_to: outbound_payment | inbound_payment | ledger_write | onchain_tx | any
 *   when:
 *     counterparty.in: <list_ref>
 *     counterparty.not_in: <list_ref>
 *     amount.lte: {currency, value}
 *     amount.gt:  {currency, value}
 *     agent.role: <role>
 *     time_window: <cron_expr>
 *   require: single_signer | <role>_approval | <role>_and_<role>
 *   execute: auto | confirm | reject
 *
 * YAML on the wire (§3 Layer 3). Internally stored as JSONB after canonical
 * serialization; policy_hash (content_hash) is sha256 of stable-serialized JSON.
 */

import { createHash } from "node:crypto";

export type ApplyTo =
  | "outbound_payment"
  | "inbound_payment"
  | "ledger_write"
  | "onchain_tx"
  | "agent_action"
  | "any";
export type ExecuteMode = "auto" | "confirm" | "reject";

export interface AmountLiteral {
  currency: string; // ISO 4217 or chain symbol
  value: string; // stringified decimal
}

/** Aggregate spend cap over a rolling window (Agent Autonomy v3, 1b.2). */
export interface SpendWindowConstraint {
  window: string; // '1h' | '24h' | '7d' | '30d'
  lte: AmountLiteral;
}

/** Aggregate transaction-count cap over a rolling window (1b.2). */
export interface TxCountWindowConstraint {
  window: string;
  lte: number;
}

export interface RuleWhen {
  "counterparty.in"?: string; // list reference: vendors.trusted
  "counterparty.not_in"?: string; // list reference: vendors.blocked
  "amount.lte"?: AmountLiteral;
  "amount.gt"?: AmountLiteral;
  "agent.role"?: string;
  time_window?: string; // cron expression
  // --- Agent Autonomy v3 (1b.5) signed authority primitives ---
  "agent.id"?: string; // match by agent id (complements agent.role)
  "tenant.category"?: "business" | "consumer";
  "action.in"?: ReadonlyArray<string>; // allowlist of action ids
  "action.not_in"?: ReadonlyArray<string>; // blocklist of action ids
  "agent.behaviorHash"?: string; // pin to a registered behaviorHash (0x-hex; Phase 2.3)
  "agent.spend_in_window"?: SpendWindowConstraint;
  "agent.tx_count_in_window"?: TxCountWindowConstraint;
  // --- H-16 agent-output gating primitives ---
  "agent.confidence.gte"?: number; // require the agent's confidence ≥ this (0..1)
  "agent.evidence_score.gte"?: number; // require evidence_score ≥ this (0..1)
  "agent.risk_level.lte"?: "low" | "medium" | "high" | "critical"; // cap the action's risk
}

export interface PolicyRule {
  id: string;
  applies_to: ReadonlyArray<ApplyTo>;
  when: RuleWhen;
  require?: string; // single_signer | <role>_approval | <role>_and_<role>
  execute: ExecuteMode;
  /**
   * Force `confirm` when the action amount exceeds this threshold, even if
   * `execute` is otherwise `auto` (1b.5). A signed alternative to scattering
   * amount.gt rules; the threshold is part of the content-hashed (signed) doc.
   */
  approval_required_above?: AmountLiteral;
}

/**
 * A tenant-approved message template for counterparty-facing agents (2.7).
 * Lives in the signed policy document so the approver signatures are covered by
 * the content hash. Free-form text outside an approved template is blocked at the
 * handler boundary — the LLM never writes counterparty-visible prose without one.
 */
export interface MessageTemplate {
  id: string;
  subject: string;
  /** Body with {{variable}} placeholders drawn only from allowed_variables. */
  body: string;
  /** The only variable names a renderer may substitute. */
  allowed_variables: ReadonlyArray<string>;
  /** Approver signatures over this template (covered by the policy content hash). */
  approver_signatures?: ReadonlyArray<string>;
}

export interface PolicyDocument {
  version: number;
  rules: ReadonlyArray<PolicyRule>;
  /** Optional registry of list references (vendors.trusted etc.). */
  lists?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Tenant-approved counterparty message templates (2.7). */
  message_templates?: ReadonlyArray<MessageTemplate>;
  /**
   * Per-agent allowlist of action keys (H-23). The ActionResolver resolves an
   * explicitly-requested action ONLY if it appears here for the agent. Part of
   * the signed/canonicalized policy (flows into contentHash). Absent agent, or
   * an empty array, means no action is allowed for that agent.
   *   e.g. { "payment": ["pay_invoice", "pay_obligation"] }
   */
  agent_actions?: Readonly<Record<string, ReadonlyArray<string>>>;
}

/**
 * H-23: the signed policy's allowlist of action keys for `agentKey`. Returns []
 * when the agent has no entry — which denies every explicitly-requested action
 * for that agent (fail-closed).
 */
export function allowedActionsFor(doc: PolicyDocument, agentKey: string): readonly string[] {
  return doc.agent_actions?.[agentKey] ?? [];
}

/**
 * Canonical JSON serialization: keys sorted recursively, no whitespace.
 * Match the output of shared/audit/hash.ts's stableStringify — we cannot
 * reuse it directly without introducing a cross-layer dep, and the
 * policy hash is a public contract so re-implementing locally is safer
 * than importing.
 */
export function canonicalize(doc: PolicyDocument): string {
  return stableStringify(doc as unknown as JsonValue);
}

export function contentHash(doc: PolicyDocument): Buffer {
  return createHash("sha256").update(canonicalize(doc), "utf8").digest();
}

export function contentHashHex(doc: PolicyDocument): string {
  return contentHash(doc).toString("hex");
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function stableStringify(v: JsonValue): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string")
    return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k]!)}`).join(",")}}`;
}
