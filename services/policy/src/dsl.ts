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

export interface RuleWhen {
  "counterparty.in"?: string; // list reference: vendors.trusted
  "counterparty.not_in"?: string; // list reference: vendors.blocked
  "amount.lte"?: AmountLiteral;
  "amount.gt"?: AmountLiteral;
  "agent.role"?: string;
  time_window?: string; // cron expression
}

export interface PolicyRule {
  id: string;
  applies_to: ReadonlyArray<ApplyTo>;
  when: RuleWhen;
  require?: string; // single_signer | <role>_approval | <role>_and_<role>
  execute: ExecuteMode;
}

export interface PolicyDocument {
  version: number;
  rules: ReadonlyArray<PolicyRule>;
  /** Optional registry of list references (vendors.trusted etc.). */
  lists?: Readonly<Record<string, ReadonlyArray<string>>>;
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
