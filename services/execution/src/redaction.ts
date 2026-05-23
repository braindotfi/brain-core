/**
 * Reasoning-trace PII redaction (INV-9).
 *
 * Raw LLM inputs/outputs and tool-call payloads are field-level redacted BEFORE
 * being stored in the redacted view (agent_reasoning_traces.tool_calls_redacted /
 * output_structured). The raw blob is encrypted at rest with a per-tenant KMS key
 * and is only readable with the audit:incident_investigation scope.
 *
 * The canonical policy document is schemas/redaction-policies/agent-trace-v1.json;
 * DEFAULT_AGENT_TRACE_POLICY mirrors it and a test asserts they stay in sync.
 */

import { createHash, createHmac } from "node:crypto";

export type RedactionTransform = "mask_last4" | "hash_recoverable" | "preserve" | "drop" | "forbid";

export interface RedactionRule {
  readonly name: string;
  readonly match: readonly string[];
  readonly transform: RedactionTransform;
  readonly retain?: readonly string[];
  readonly key_scope?: "tenant";
}

export interface RedactionPolicy {
  readonly id: string;
  readonly version: number;
  readonly description?: string;
  readonly rules: readonly RedactionRule[];
  readonly defaults: { readonly unmatched: "preserve" | "drop" };
}

export const DEFAULT_AGENT_TRACE_POLICY: RedactionPolicy = {
  id: "agent-trace-v1",
  version: 1,
  description:
    "Default field-level redaction policy for agent reasoning traces (INV-9). Applied to raw LLM inputs/outputs and tool-call payloads BEFORE they are stored in the redacted view. The raw blob is encrypted at rest with a per-tenant KMS key and is only readable with the audit:incident_investigation scope.",
  rules: [
    {
      name: "account_numbers",
      match: ["account_number", "account_no", "acct", "iban", "routing_number"],
      transform: "mask_last4",
    },
    {
      name: "counterparty_names",
      match: ["counterparty_name", "payee", "payer", "vendor_name", "merchant_name"],
      transform: "hash_recoverable",
      key_scope: "tenant",
    },
    {
      name: "amounts",
      match: ["amount", "amount_due", "value", "balance", "currency"],
      transform: "preserve",
    },
    {
      name: "email_bodies",
      match: ["email_body", "body", "message_body", "html_body", "text_body"],
      transform: "drop",
      retain: ["subject", "hash"],
    },
    {
      name: "bank_credentials",
      match: [
        "password",
        "secret",
        "access_token",
        "plaid_access_token",
        "api_key",
        "private_key",
        "card_number",
        "cvv",
        "pin",
      ],
      transform: "forbid",
    },
  ],
  defaults: { unmatched: "preserve" },
};

export interface RedactOptions {
  /**
   * Per-tenant key for recoverable hashing. In production this is derived from
   * the tenant's KMS key; the same key recovers the value during an incident
   * investigation.
   * TODO(agent-autonomy-v3, INV-9): source this from the tenant KMS key.
   */
  readonly tenantHashKey: string;
}

function maskLast4(value: string): string {
  if (value.length <= 4) {
    return "****";
  }
  return `****${value.slice(-4)}`;
}

function hashRecoverable(value: string, key: string): string {
  return `h:${createHmac("sha256", key).update(value).digest("hex")}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ruleFor(policy: RedactionPolicy, key: string): RedactionRule | undefined {
  const lower = key.toLowerCase();
  return policy.rules.find((r) => r.match.some((m) => m.toLowerCase() === lower));
}

/**
 * Apply `policy` to `payload`, returning a redacted clone. Recurses into nested
 * objects and arrays. Throws if a `forbid` field (bank credentials) is present —
 * those must never reach storage.
 */
export function redact(policy: RedactionPolicy, payload: unknown, opts: RedactOptions): unknown {
  if (Array.isArray(payload)) {
    return payload.map((v) => redact(policy, v, opts));
  }
  if (payload === null || typeof payload !== "object") {
    return payload;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const rule = ruleFor(policy, key);
    if (rule === undefined) {
      out[key] = policy.defaults.unmatched === "drop" ? undefined : redact(policy, value, opts);
      continue;
    }
    switch (rule.transform) {
      case "forbid":
        throw new Error(`redaction: forbidden field "${key}" must not be present in a trace`);
      case "preserve":
        out[key] = redact(policy, value, opts);
        break;
      case "mask_last4":
        out[key] = typeof value === "string" ? maskLast4(value) : value;
        break;
      case "hash_recoverable":
        out[key] = typeof value === "string" ? hashRecoverable(value, opts.tenantHashKey) : value;
        break;
      case "drop":
        // Drop the value; retain a hash when the rule asks for it.
        if (rule.retain?.includes("hash") === true && typeof value === "string") {
          out[`${key}_sha256`] = sha256Hex(value);
        }
        break;
    }
  }
  return out;
}
