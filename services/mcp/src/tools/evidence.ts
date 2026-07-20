/**
 * Evidence resolution tools.
 *
 * Mirrors POST /v1/evidence/resolve for MCP clients. The backing service is
 * the same resolver used by HTTP, so resolvable and not_found semantics stay
 * tenant-scoped and fail closed.
 */

import { parseEvidenceResolveBody } from "@brain/execution";
import { requireToolService, type Tool, type ToolContext, type ToolResult } from "./types.js";

interface EvidenceResolveInput {
  refs: ReturnType<typeof parseEvidenceResolveBody>;
}

export const evidenceResolveTool: Tool<EvidenceResolveInput> = {
  name: "evidence.resolve",
  description:
    "Resolve typed proposal evidence refs into tenant-scoped summaries and deep links where the ref kind is supported.",
  requiredScopes: ["execution:read"],
  inputSchema: {
    type: "object",
    required: ["refs"],
    properties: {
      refs: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          required: ["kind", "ref"],
          properties: {
            kind: { type: "string" },
            ref: { type: "string" },
          },
        },
      },
    },
  },
  parseInput(params): EvidenceResolveInput {
    return { refs: parseEvidenceResolveBody({ refs: params.refs }) };
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const evidence = requireToolService(ctx.evidence, "evidence.resolve");
    const results = await evidence.resolve(ctx.ctx, input.refs);
    const found = results.filter((item) => item.resolvable && !item.not_found).length;
    const unsupported = results.filter((item) => !item.resolvable).length;
    return {
      payload: { results },
      summary:
        `Resolved ${found} evidence ref(s). ` +
        `${unsupported} unsupported or malformed ref(s). ` +
        `${results.length - found - unsupported} supported ref(s) not found.`,
    };
  },
};

export const evidenceTools: Tool[] = [evidenceResolveTool as unknown as Tool];
