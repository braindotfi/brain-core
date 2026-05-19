/**
 * agent.action.propose — non-financial agent proposals.
 *
 * For actions that have NO money-movement side effect — flagging an
 * anomaly, suggesting a categorization fix, recommending a new
 * obligation be created. Anything money-touching uses
 * `payment_intent.propose` instead, which carries its own §6 gate.
 */

import { type Tool, type ToolContext, type ToolResult } from "./types.js";

interface AgentProposeInput {
  /** Action shape — Brain accepts arbitrary JSON; the policy DSL
   *  validates against the action_kind on evaluation. */
  action: Record<string, unknown>;
}

export const agentProposeTool: Tool<AgentProposeInput> = {
  name: "agent.action.propose",
  description:
    "Propose a non-financial action (e.g., flag anomaly, suggest categorization). Brain evaluates against the active policy and returns the proposal id + decision.",
  requiredScopes: ["agent:propose"],
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "object",
        description:
          "Free-form action object validated against the policy DSL. Must include `kind`.",
        additionalProperties: true,
      },
    },
  },
  parseInput(params): AgentProposeInput {
    const action = params.action;
    if (typeof action !== "object" || action === null || Array.isArray(action)) {
      throw {
        code: "request_params_invalid",
        message: "'action' must be a JSON object",
      };
    }
    if (typeof (action as Record<string, unknown>).kind !== "string") {
      throw {
        code: "request_params_invalid",
        message: "action.kind is required",
      };
    }
    return { action: action as Record<string, unknown> };
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    // The Agent layer (services/execution) exposes proposal creation via
    // its IAgentService contract; that's what we call. When the service
    // isn't wired (test mode), we soft-degrade to an audit-only stub
    // rather than failing — this keeps the tool callable in isolation.
    const svc = ctx.agentService;
    if (svc === undefined) {
      // Soft-degrade: emit an audit and return a synthetic id. This keeps
      // the tool callable in environments where the Agent layer isn't
      // wired (e.g. mock-pool unit tests). Production always wires svc.
      const stubId = `prop_stub_${Date.now().toString(36)}`;
      await ctx.audit.emit({
        tenantId: ctx.ctx.tenantId,
        layer: "agent",
        actor: ctx.ctx.actor,
        action: "agent.action.propose.unwired",
        inputs: { action_kind: String(input.action.kind ?? "unknown") },
        outputs: { stub_id: stubId },
      });
      return {
        payload: { proposal_id: stubId, status: "unwired", note: "IAgentService not configured" },
        summary: `Proposal recorded as audit-only stub \`${stubId}\` (Agent service not wired in this environment).`,
      };
    }
    const proposal = await svc.propose(ctx.ctx, ctx.agent.id, { action: input.action });
    return {
      payload: proposal,
      summary:
        `Proposal \`${proposal.id}\` created with status **${proposal.status}**.\n` +
        `Action kind: ${String(input.action.kind ?? "unknown")}\n` +
        `Policy decision: \`${proposal.policy_decision_id}\``,
    };
  },
};

export const agentTools: Tool[] = [agentProposeTool as unknown as Tool];
