/**
 * ActionResolver — picks the specific action within an already-selected agent.
 *
 * Runs AFTER the router has selected an agent (it does NOT touch routing
 * scoring). Resolution order (Agent Autonomy v3, 1a.1):
 *
 *   1. explicit requested action in the input context
 *      (must be one the agent offers; future: must pass the policy
 *       template's action.in check — see TODO below)
 *   2. event_action_map match (by event)
 *   3. intent_action_map match (scored via the configured IntentClassifier)
 *   4. default_action — only if the agent explicitly declares one
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
}

export interface ActionResolverDeps {
  readonly classifier: IntentClassifier;
  /** Intent-pattern match threshold for intent_action_map. Defaults to 0.5. */
  readonly intentMatchThreshold?: number;
  /**
   * Authorization hook for an explicitly requested action — the signed policy
   * template's action.in / action.not_in check (Policy DSL, plan 1b.5). When
   * absent (Phase 1a), an explicit action is accepted as long as the agent
   * offers it.
   * TODO(agent-autonomy-v3, 1b.5): wire the policy template action allowlist here.
   */
  readonly isActionAllowed?: (agentKey: string, action: string) => boolean;
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

    // 1 — explicit requested action.
    const requested = readRequestedAction(input.context);
    if (requested !== undefined) {
      if (!offered.has(requested)) {
        return {
          status: "missing_action",
          reason: `requested action "${requested}" is not offered by ${agentKey}`,
        };
      }
      if (
        this.deps.isActionAllowed !== undefined &&
        !this.deps.isActionAllowed(agentKey, requested)
      ) {
        return {
          status: "missing_action",
          reason: `requested action "${requested}" is denied by policy for ${agentKey}`,
        };
      }
      return { status: "resolved", action: requested, source: "explicit" };
    }

    // 2 — event_action_map.
    if (input.event !== undefined) {
      const mapped = input.definition.event_action_map?.[input.event];
      if (mapped !== undefined && offered.has(mapped)) {
        return { status: "resolved", action: mapped, source: "event_map" };
      }
    }

    // 3 — intent_action_map (scored via the classifier).
    if (input.intent !== undefined && input.definition.intent_action_map !== undefined) {
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
        return { status: "resolved", action: best.action, source: "intent_map" };
      }
    }

    // 4 — default_action (opt-in only).
    const fallback = input.definition.default_action;
    if (fallback !== undefined && offered.has(fallback)) {
      return { status: "resolved", action: fallback, source: "default" };
    }

    return { status: "missing_action", reason: `no action resolved for ${agentKey}` };
  }
}
