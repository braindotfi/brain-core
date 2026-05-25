/**
 * H-15 Agent Capability Manifest — the canonical, formal description of what an
 * agent may do. Improves router eligibility filtering, policy decisions, and
 * external-agent registration (the manifest's canonical-JSON keccak256 is the
 * on-chain scope hash).
 *
 * Internal agents derive their manifest from the InternalAgentDefinition via
 * {@link buildManifest} (one source of truth — no hand-maintained per-agent
 * manifest files). External agents submit a manifest at registration.
 */

import type {
  AgentCategory,
  AgentRiskLevel,
  InternalAgentDefinition,
  RequiredEvidence,
} from "./agent-definition.js";

export interface AgentManifestFailureMode {
  code: string;
  description: string;
  fallback_action: string;
}

export interface AgentManifest {
  agent_key: string;
  category: AgentCategory;
  /** Canonical scope strings: "ledger:read", etc. */
  capabilities: string[];
  /** Entity types / data classes the agent may read. */
  can_read: string[];
  /** Entity types the agent may write (empty in MVP — agents propose, not write). */
  can_write: string[];
  /** Action types the agent may propose. */
  can_propose: string[];
  /** Always false for the MVP — execution is Brain-internal behind the §6 gate. */
  can_execute: boolean;
  /** Rails this agent may use once promoted (["ach"], …); [] for non-money-movers. */
  allowed_rails: string[];
  /** Kinds of raw_parsed evidence the agent requires. */
  required_evidence: string[];
  max_risk_level: AgentRiskLevel;
  policy_primitives_required: string[];
  audit_events_emitted: string[];
  failure_modes: AgentManifestFailureMode[];
  fallback_agent_ids: string[];
  confidence_output: {
    returns_confidence: boolean;
    returns_evidence_score: boolean;
    returns_missing_evidence: boolean;
  };
}

function evidenceKind(e: RequiredEvidence): string {
  return typeof e === "string" ? e : e.kind;
}

/** Distinct action ids an agent can produce (event map + intent map + default). */
function proposableActions(def: InternalAgentDefinition): string[] {
  const out = new Set<string>();
  for (const a of Object.values(def.event_action_map ?? {})) out.add(a);
  for (const r of def.intent_action_map ?? []) out.add(r.action);
  if (def.default_action !== undefined) out.add(def.default_action);
  return [...out];
}

/**
 * Derive the canonical manifest for an internal agent from its definition.
 * Fields the definition does not carry (allowed_rails, policy primitives, audit
 * events, failure modes, fallbacks) default conservatively: rails are governed
 * by promotion-config (H-24), and confidence_output is always all-true since
 * every agent emits the canonical AgentOutput (H-16).
 */
export function buildManifest(def: InternalAgentDefinition): AgentManifest {
  return {
    agent_key: def.agent_key,
    category: def.category,
    capabilities: [...def.capabilities],
    can_read: [...def.readable_data],
    can_write: [],
    can_propose: proposableActions(def),
    can_execute: false,
    allowed_rails: [],
    required_evidence: def.required_evidence.map(evidenceKind),
    max_risk_level: def.risk_level,
    policy_primitives_required: [],
    audit_events_emitted: [],
    failure_modes: [],
    fallback_agent_ids: [],
    confidence_output: {
      returns_confidence: true,
      returns_evidence_score: true,
      returns_missing_evidence: true,
    },
  };
}

/** Canonical JSON (recursively key-sorted) — the preimage for the scope hash. */
export function canonicalManifest(manifest: AgentManifest): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  };
  return stable(manifest);
}

/** Structural validation. Returns the list of problems ([] = valid). */
export function validateManifest(manifest: unknown): string[] {
  const problems: string[] = [];
  if (manifest === null || typeof manifest !== "object") return ["manifest must be an object"];
  const m = manifest as Record<string, unknown>;
  const requireStr = (k: string): void => {
    if (typeof m[k] !== "string" || (m[k] as string).length === 0)
      problems.push(`${k} must be a non-empty string`);
  };
  const requireArr = (k: string): void => {
    if (!Array.isArray(m[k])) problems.push(`${k} must be an array`);
  };
  requireStr("agent_key");
  requireStr("category");
  requireStr("max_risk_level");
  for (const k of [
    "capabilities",
    "can_read",
    "can_write",
    "can_propose",
    "allowed_rails",
    "required_evidence",
    "policy_primitives_required",
    "audit_events_emitted",
    "failure_modes",
    "fallback_agent_ids",
  ]) {
    requireArr(k);
  }
  if (m.can_execute !== false) problems.push("can_execute must be false (MVP)");
  const co = m.confidence_output as Record<string, unknown> | undefined;
  if (co === undefined || co.returns_confidence !== true) {
    problems.push("confidence_output.returns_confidence must be true (MVP)");
  }
  return problems;
}
