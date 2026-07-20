/**
 * Proposal interaction tools.
 *
 * These tools mirror the HTTP /v1/proposals read and decision routes. The
 * handlers delegate to the same read model and ProposalDecisionService wired
 * by the API composition root, so tenant scoping, actor resolution, member
 * authority, and money-path approval checks stay in one place.
 */

import {
  PROPOSAL_DECISIONS,
  PROPOSAL_TYPES,
  type ListProposalsInput,
  type ProposalDecision,
  type ProposalRiskBand,
  type ProposalType,
} from "@brain/execution";
import { brainError } from "@brain/shared";
import {
  optionalInteger,
  optionalNumber,
  optionalString,
  requireAnyScope,
  requireString,
  requireToolService,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.js";

const RISK_BANDS = ["low", "standard", "elevated", "high"] as const;
const PROPOSAL_STATUS_VALUES = [
  "proposed",
  "pending",
  "pending_approval",
  "awaiting_second_approval",
  "approved",
  "acknowledged",
  "reconciling",
  "paused",
  "dispatching",
  "rejected",
  "executed",
  "failed",
  "cancelled",
  "undone",
  "unknown",
] as const;

interface ProposalsListInput {
  type?: ProposalType;
  status?: string;
  risk_band?: ProposalRiskBand;
  min_confidence?: number;
  limit?: number;
  cursor?: string;
}

export const proposalsListTool: Tool<ProposalsListInput> = {
  name: "proposals.list",
  description:
    "List customer-facing agent proposals across payment intents and non-money agent findings. Tenant-scoped and cursor-paginated.",
  requiredScopes: ["execution:read"],
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: [...PROPOSAL_TYPES] },
      status: { type: "string", enum: [...PROPOSAL_STATUS_VALUES] },
      risk_band: { type: "string", enum: [...RISK_BANDS] },
      min_confidence: { type: "number", minimum: 0, maximum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string" },
    },
  },
  parseInput(params): ProposalsListInput {
    const out: ProposalsListInput = {};
    const type = optionalString(params, "type");
    if (type !== undefined) {
      if (!(PROPOSAL_TYPES as readonly string[]).includes(type)) {
        throw brainError("request_params_invalid", "type invalid", {
          details: { type, allowed: PROPOSAL_TYPES },
        });
      }
      out.type = type as ProposalType;
    }
    const status = optionalString(params, "status");
    if (status !== undefined) {
      if (!(PROPOSAL_STATUS_VALUES as readonly string[]).includes(status)) {
        throw brainError("request_params_invalid", "status invalid", {
          details: { status, allowed: PROPOSAL_STATUS_VALUES },
        });
      }
      out.status = status;
    }
    const riskBand = optionalString(params, "risk_band");
    if (riskBand !== undefined) {
      if (!(RISK_BANDS as readonly string[]).includes(riskBand)) {
        throw brainError("request_params_invalid", "risk_band invalid", {
          details: { risk_band: riskBand, allowed: RISK_BANDS },
        });
      }
      out.risk_band = riskBand as ProposalRiskBand;
    }
    const minConfidence = optionalNumber(params, "min_confidence");
    if (minConfidence !== undefined) {
      if (minConfidence < 0 || minConfidence > 1) {
        throw brainError("request_params_invalid", "min_confidence must be between 0 and 1");
      }
      out.min_confidence = minConfidence;
    }
    const limit = optionalInteger(params, "limit");
    if (limit !== undefined) {
      if (limit < 1 || limit > 100) {
        throw brainError("request_params_invalid", "limit must be an integer in [1, 100]");
      }
      out.limit = limit;
    } else if (params.limit !== undefined) {
      throw brainError("request_params_invalid", "limit must be an integer in [1, 100]");
    }
    const cursor = optionalString(params, "cursor");
    if (cursor !== undefined) out.cursor = cursor;
    return out;
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const proposals = requireToolService(ctx.proposals, "proposals.list");
    const result = await proposals.list(ctx.ctx, input as ListProposalsInput);
    const lines = result.proposals.slice(0, 10).map((proposal) => {
      const confidence = proposal.confidence === null ? "unknown" : proposal.confidence.toFixed(2);
      return `- \`${proposal.id}\` ${proposal.type} status=${proposal.status} confidence=${confidence}`;
    });
    const more =
      result.proposals.length > 10 ? `\n(${result.proposals.length - 10} more in this page)` : "";
    return {
      payload: result,
      summary:
        result.proposals.length === 0
          ? "No proposals match."
          : `${result.proposals.length} proposal(s):\n${lines.join("\n")}${more}`,
    };
  },
};

interface ProposalsGetInput {
  proposal_id: string;
}

export const proposalsGetTool: Tool<ProposalsGetInput> = {
  name: "proposals.get",
  description: "Read one tenant-scoped proposal by id.",
  requiredScopes: ["execution:read"],
  inputSchema: {
    type: "object",
    required: ["proposal_id"],
    properties: {
      proposal_id: { type: "string" },
    },
  },
  parseInput(params): ProposalsGetInput {
    return { proposal_id: requireString(params, "proposal_id") };
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const proposals = requireToolService(ctx.proposals, "proposals.get");
    const proposal = await proposals.get(ctx.ctx, input.proposal_id);
    if (proposal === null) {
      throw brainError("execution_proposal_not_found", "no such proposal");
    }
    return {
      payload: proposal,
      summary:
        `Proposal \`${proposal.id}\` is **${proposal.status}**.\n` +
        `Type: ${proposal.type}\n` +
        `Mode: ${proposal.mode}\n` +
        `Evidence refs: ${proposal.evidence.length}`,
    };
  },
};

interface ProposalsDecideInput {
  proposal_id: string;
  decision: ProposalDecision;
}

export const proposalsDecideTool: Tool<ProposalsDecideInput> = {
  name: "proposals.decide",
  description:
    "Record a human decision on a proposal. Delegates to the HTTP proposal decision service, including user-principal actor resolution, active-member checks, approval role checks, money-path approval gates, and audit.",
  requiredScopes: [],
  inputSchema: {
    type: "object",
    required: ["proposal_id", "decision"],
    properties: {
      proposal_id: { type: "string" },
      decision: { type: "string", enum: [...PROPOSAL_DECISIONS] },
    },
  },
  parseInput(params): ProposalsDecideInput {
    const decision = requireString(params, "decision");
    if (!(PROPOSAL_DECISIONS as readonly string[]).includes(decision)) {
      throw brainError(
        "request_params_invalid",
        "decision must be approve, reject, acknowledge, or undo",
      );
    }
    return {
      proposal_id: requireString(params, "proposal_id"),
      decision: decision as ProposalDecision,
    };
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    requireAnyScope(ctx.ctx.scopes ?? [], ["payment_intent:approve", "execution:read"]);
    const proposals = requireToolService(ctx.proposals, "proposals.decide");
    const result = await proposals.decide(ctx.ctx, input.proposal_id, input.decision);
    return {
      payload: result,
      summary:
        `Proposal \`${result.id}\` decision \`${result.decision}\` recorded with status **${result.status}**.\n` +
        `Audit: \`${result.audit_id ?? "already_recorded"}\``,
    };
  },
};

export const proposalTools: Tool[] = [
  proposalsListTool as unknown as Tool,
  proposalsGetTool as unknown as Tool,
  proposalsDecideTool as unknown as Tool,
];
