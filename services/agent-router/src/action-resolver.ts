/**
 * ActionResolver — picks the specific action within an already-selected agent.
 *
 * Runs AFTER the router has selected an agent (it does NOT touch routing
 * scoring). Resolution order (Agent Autonomy v3, 1a.1):
 *
 *   1. explicit requested action in the input context (must be one the agent
 *      offers)
 *   2. event_action_map match (by event)
 *   3. intent_action_map match (scored via the configured IntentClassifier)
 *   4. default_action — only if the agent explicitly declares one
 *
 * Whichever source wins, the resolved candidate is then authorized against the
 * signed per-agent allowlist (`isActionAllowed`, PolicyDocument.agent_actions)
 * before it is returned — the allowlist gates EVERY source, not just explicit
 * requests (Codex 2026-06-05 P1). A denied candidate becomes missing_action.
 *
 * If nothing resolves it returns { status: "missing_action" }. It NEVER
 * silently falls back to handler.actions[0] (anti-pattern, see plan).
 */

import type { InternalAgentDefinition } from "@brain/schemas";
import type { IntentClassifier } from "./intent-classifier.js";

/** Context key carrying an explicitly requested action id. */
export const REQUESTED_ACTION_KEY = "requested_action";

/** Default intent-pattern match threshold (mirrors the router's). */
const DEFAULT_INTENT_THRESHOLD = 0.5;

export type ActionSource = "explicit" | "event_map" | "intent_map" | "default";

export type ActionResolution =
  | { readonly status: "resolved"; readonly action: string; readonly source: ActionSource }
  | { readonly status: "missing_action"; readonly reason: string };

export interface ActionResolutionInput {
  readonly definition: InternalAgentDefinition;
  /** The selected agent's declared actions (the available set). */
  readonly actions: readonly string[];
  readonly event?: string;
  readonly intent?: string;
  readonly context?: Record<string, unknown>;
  /**
   * Tenant whose signed policy governs the per-agent action allowlist (H-23).
   * Threaded to the `isActionAllowed` hook so the allowlist always evaluates
   * against the REQUESTING tenant's active policy (never a boot-time closure
   * over one tenant's policy). The hook is consulted whenever it is configured
   * — a missing tenant does NOT skip the check (that would let a caller bypass
   * policy by omitting the tenant); instead the hook receives `undefined` and
   * the wiring decides (no tenant ⇒ no policy ⇒ allow, same as pre-H-23).
   */
  readonly tenantId?: string;
}

export interface ActionResolverDeps {
  readonly classifier: IntentClassifier;
  /** Intent-pattern match threshold for intent_action_map. Defaults to 0.5. */
  readonly intentMatchThreshold?: number;
  /**
   * Authorization hook for the resolved candidate action, whatever source
   * selected it (explicit / event_map / intent_map / default) — the signed
   * policy's per-agent allowlist (`PolicyDocument.agent_actions`; see
   * `allowedActionsFor` in @brain/policy). Receives the requesting tenant's id
   * so the wiring loads THAT tenant's active signed policy per call (H-23)
   * rather than closing over one tenant's policy at boot. Consulted whenever
   * configured; when absent the resolver accepts any action the agent offers.
   * `tenantId` may be undefined (callers that don't supply one) — the wiring
   * treats that as "no policy to enforce ⇒ allow", but a configured hook is
   * still always invoked so a deny decision can never be skipped by omitting
   * the tenant.
   */
  readonly isActionAllowed?: (
    tenantId: string | undefined,
    agentKey: string,
    action: string,
  ) => boolean | Promise<boolean>;
  /**
   * Observability hook fired when `isActionAllowed` denies the resolved
   * candidate (Codex 2026-06-05 P1 follow-up). The wiring supplies an emitter
   * that records an audit event with the tenant, agent, candidate action, and
   * the resolution source, so a policy denial is visible in the trail rather
   * than only surfacing as a `missing_action` to the caller. Kept as a callback
   * so the resolver stays free of an audit dependency.
   */
  readonly onPolicyDenied?: (info: {
    tenantId: string | undefined;
    agentKey: string;
    action: string;
    source: ActionSource;
  }) => void | Promise<void>;
}

function readRequestedAction(context: Record<string, unknown> | undefined): string | undefined {
  const v = context?.[REQUESTED_ACTION_KEY];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export class ActionResolver {
  constructor(private readonly deps: ActionResolverDeps) {}

  async resolve(input: ActionResolutionInput): Promise<ActionResolution> {
    const offered = new Set(input.actions);
    const agentKey = input.definition.agent_key;

    // Stage 1 — pick a candidate action via the resolution precedence
    // (explicit → event_map → intent_map → default), WITHOUT authorizing yet.
    let candidate: { action: string; source: ActionSource } | undefined;

    // 1 — explicit requested action. A requested-but-not-offered action is a
    // bad request (distinct from a policy denial) and short-circuits here so it
    // never silently falls back to an event/intent/default mapping.
    const requested = readRequestedAction(input.context);
    if (requested !== undefined) {
      if (!offered.has(requested)) {
        return {
          status: "missing_action",
          reason: `requested action "${requested}" is not offered by ${agentKey}`,
        };
      }
      candidate = { action: requested, source: "explicit" };
    }

    // 2 — event_action_map.
    if (candidate === undefined && input.event !== undefined) {
      const mapped = input.definition.event_action_map?.[input.event];
      if (mapped !== undefined && offered.has(mapped)) {
        candidate = { action: mapped, source: "event_map" };
      }
    }

    // 3 — intent_action_map (scored via the classifier).
    if (
      candidate === undefined &&
      input.intent !== undefined &&
      input.definition.intent_action_map !== undefined
    ) {
      const threshold = this.deps.intentMatchThreshold ?? DEFAULT_INTENT_THRESHOLD;
      let best: { action: string; score: number } | undefined;
      for (const rule of input.definition.intent_action_map) {
        if (!offered.has(rule.action)) {
          continue;
        }
        const score = await this.deps.classifier.classify(input.intent, rule.patterns);
        if (score >= threshold && (best === undefined || score > best.score)) {
          best = { action: rule.action, score };
        }
      }
      if (best !== undefined) {
        candidate = { action: best.action, source: "intent_map" };
      }
    }

    // 4 — default_action (opt-in only).
    if (candidate === undefined) {
      const fallback = input.definition.default_action;
      if (fallback !== undefined && offered.has(fallback)) {
        candidate = { action: fallback, source: "default" };
      }
    }

    if (candidate === undefined) {
      return { status: "missing_action", reason: `no action resolved for ${agentKey}` };
    }

    // Stage 2 — authorize the FINAL candidate against the signed per-agent
    // allowlist, regardless of which source selected it (Codex 2026-06-05 P1).
    // Previously this ran only on the explicit path, so an event mapping, a
    // classifier match, or a declared default could smuggle a denied action
    // past PolicyDocument.agent_actions. The hook is consulted whenever it is
    // configured; a missing tenant does NOT skip it (the hook receives
    // `undefined` and the wiring decides "no tenant ⇒ allow", never the
    // resolver — see services/api/src/main.ts).
    if (this.deps.isActionAllowed !== undefined) {
      const allowed = await this.deps.isActionAllowed(input.tenantId, agentKey, candidate.action);
      if (!allowed) {
        await this.deps.onPolicyDenied?.({
          tenantId: input.tenantId,
          agentKey,
          action: candidate.action,
          source: candidate.source,
        });
        return {
          status: "missing_action",
          reason: `action "${candidate.action}" is denied by policy for ${agentKey} (source=${candidate.source})`,
        };
      }
    }

    return { status: "resolved", action: candidate.action, source: candidate.source };
  }
}
