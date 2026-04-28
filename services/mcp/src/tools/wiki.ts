/**
 * Wiki-read tools: natural-language Q&A and page lookup.
 *
 * `wiki.question` is the canonical Brain reasoning surface: an agent
 * asks a question, Brain grounds the answer in Ledger rows, and returns
 * structured evidence ids alongside the prose. Per the v0.3
 * architecture, the answer never grounds in Wiki text.
 */

import {
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// wiki.question
// ---------------------------------------------------------------------------

interface QuestionInput {
  question: string;
  as_of?: string;
  max_evidence_depth?: number;
}

export const questionTool: Tool<QuestionInput> = {
  name: "wiki.question",
  description:
    "Ask a natural-language question about the tenant's financial state. The answer is grounded in Ledger rows; evidence_ids in the response are typed Brain ids the caller can resolve.",
  requiredScopes: ["wiki:read"],
  inputSchema: {
    type: "object",
    required: ["question"],
    properties: {
      question: { type: "string", minLength: 1, maxLength: 2000 },
      as_of: { type: "string", format: "date-time" },
      max_evidence_depth: { type: "integer", minimum: 1, maximum: 5 },
    },
  },
  parseInput(params): QuestionInput {
    const out: QuestionInput = { question: requireString(params, "question") };
    const asOf = optionalString(params, "as_of");
    const depth = optionalNumber(params, "max_evidence_depth");
    if (asOf !== undefined) out.as_of = asOf;
    if (depth !== undefined) out.max_evidence_depth = depth;
    return out;
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const result = await ctx.wiki.question(ctx.ctx, {
      question: input.question,
      asOf: input.as_of ?? null,
      maxEvidenceDepth: input.max_evidence_depth ?? 3,
    });
    const evLines = result.evidence
      .slice(0, 8)
      .map((e) => `  - \`${e.entityId}\` (${e.entityType}): ${e.excerpt}`);
    return {
      payload: result,
      summary:
        `**Q:** ${input.question}\n` +
        `**A:** ${result.answer}\n\n` +
        `Cited evidence:\n${evLines.length === 0 ? "  _none_" : evLines.join("\n")}\n\n` +
        `_(model: ${result.model}, tokens: ${result.usage.inputTokens + result.usage.outputTokens})_`,
    };
  },
};

// ---------------------------------------------------------------------------
// wiki.page.get
// ---------------------------------------------------------------------------

interface PageGetInput {
  slug_or_id: string;
}

export const pageGetTool: Tool<PageGetInput> = {
  name: "wiki.page.get",
  description:
    "Fetch a wiki memory page by slug or id. Pages are derived from current Ledger state and follow the standard Brain memory-page sections (Current Truth, Linked Entities, Recent Activity, Open Questions, Risk Notes, Timeline, Evidence).",
  requiredScopes: ["wiki:read"],
  inputSchema: {
    type: "object",
    required: ["slug_or_id"],
    properties: {
      slug_or_id: { type: "string", description: "/accounts/acct_X | wpg_X | acct_X" },
    },
  },
  parseInput(params): PageGetInput {
    return { slug_or_id: requireString(params, "slug_or_id") };
  },
  async handle(ctx, input): Promise<ToolResult> {
    const page = await ctx.wiki.getPage(ctx.ctx, input.slug_or_id);
    if (page === null) {
      return {
        payload: { found: false },
        summary: `No wiki page at \`${input.slug_or_id}\`. Try \`wiki.question\` instead.`,
      };
    }
    return {
      payload: page,
      summary: page.body_md,
    };
  },
};

export const wikiTools: Tool[] = [questionTool as unknown as Tool, pageGetTool as unknown as Tool];
