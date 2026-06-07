/**
 * Canonical hashing of audit events for the per-tenant hash chain.
 *
 * §5.3 / §3 Layer 5: events are Merkle-anchored hourly. The hash used for
 * both the per-event row and the leaves of the Merkle tree must be
 * deterministic and stable across service versions — changing the
 * serialization changes every verifier's math.
 *
 * Strategy: JCS-like stable serialization. Sort keys, no whitespace, use
 * native JSON types only, include `prev_event_hash` (hex) so chaining is
 * intrinsic to the hash. The implementation deliberately avoids external
 * canonicalization libraries; we own this serialization forever.
 */

import { createHash } from "node:crypto";
import type { AuditEventInput } from "./types.js";

/**
 * Version of the canonical-hash serialization that produced an event's
 * `event_hash`. Persisted per row (`audit_events.hash_schema_version`) so the
 * consistency verifier recomputes and compares ONLY events written under the
 * current canonicalization, never flagging rows produced by a superseded form
 * (e.g. the pre-BYTEA-fix Buffer serialization). Bump this whenever
 * `canonicalize` changes; 0 means "pre-versioning" and is skipped by the
 * verifier. (Codex c96283d P1 #2.)
 */
export const AUDIT_HASH_SCHEMA_VERSION = 1;

export interface HashInput {
  readonly event: AuditEventInput;
  /** Event id (ULID). Included to break ties in edge cases where two
   *  otherwise-identical events coexist (rare but possible in tests). */
  readonly id: string;
  /** ISO-8601 timestamp as recorded. Fixed so re-computation is deterministic. */
  readonly createdAt: string;
  /** Previous event's hex-encoded hash, or null if this is the first in the
   *  tenant's chain. */
  readonly prevEventHash: string | null;
}

export function canonicalize(input: HashInput): string {
  const e = input.event;
  // `inputs` and `outputs` may be nested objects — stable-serialize them too.
  // v0.3 fields (policy_decision_id, before_state, after_state) participate in
  // the canonical hash so the chain breaks when any of them mutate. Prior
  // events without these fields canonicalize to null for each, which is
  // backward-compatible with v0.1 hashes.
  const payload = {
    id: input.id,
    tenant_id: e.tenantId,
    layer: e.layer,
    actor: e.actor,
    action: e.action,
    inputs: stableJsonValue(e.inputs),
    outputs: stableJsonValue(e.outputs),
    policy_version: e.policyVersion ?? null,
    policy_decision_id: e.policyDecisionId ?? null,
    before_state: e.beforeState === undefined ? null : stableJsonValue(e.beforeState),
    after_state: e.afterState === undefined ? null : stableJsonValue(e.afterState),
    created_at: input.createdAt,
    prev_event_hash: input.prevEventHash,
  };
  return stableStringify(payload);
}

export function hashEvent(input: HashInput): string {
  return createHash("sha256").update(canonicalize(input), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Stable stringify
//
// Keys sorted. Arrays preserved. Nested objects recursively stabilized.
// Numbers serialized in JSON default form. No whitespace. Functions and
// undefined keys are rejected at the call site — audit events come from
// typed inputs that can't carry them in practice.
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function stableJsonValue(v: unknown): JsonValue {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v as JsonValue;
  if (Array.isArray(v)) return v.map(stableJsonValue);
  if (t === "object") {
    const out: { [k: string]: JsonValue } = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      out[k] = stableJsonValue(x);
    }
    return out;
  }
  // Fallback — coerce unknowns to their string form. Audit emitters should
  // never pass functions/symbols, but this keeps the function total.
  return String(v);
}

export function stableStringify(v: JsonValue): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k]!)}`).join(",");
  return `{${body}}`;
}
