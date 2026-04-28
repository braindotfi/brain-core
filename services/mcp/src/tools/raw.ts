/**
 * Raw contribution tool — the path by which an external agent pushes
 * structured observations into Brain's evidence store.
 *
 * The artifact is content-addressed by sha256, attributed to the agent's
 * on-chain registration record, and ingested with `source_type =
 * agent_contributed`. Any Ledger rows derived from it carry
 * `provenance = agent_contributed` and start at confidence ceiling 0.5
 * per §3.2 of the architecture.
 */

import { requireString, type Tool, type ToolContext, type ToolResult } from "./types.js";

interface RawContributeInput {
  /** Free-form payload the agent wants to attribute to itself. */
  payload: string;
  /** MIME type of the payload (default: application/json). */
  mime_type?: string;
  /** Optional source-specific identifiers (e.g. transcript id, doc id). */
  source_ref?: Record<string, unknown>;
}

export const rawContributeTool: Tool<RawContributeInput> = {
  name: "raw.contribute",
  description:
    "Submit a raw artifact attributed to this agent. Returns the raw_id once stored. Subsequent extractions into the Ledger will carry provenance=agent_contributed and confidence ≤ 0.5.",
  requiredScopes: ["raw:write"],
  inputSchema: {
    type: "object",
    required: ["payload"],
    properties: {
      payload: { type: "string", description: "Artifact bytes as a string. JSON, text, or base64-encoded binary." },
      mime_type: { type: "string", default: "application/json" },
      source_ref: { type: "object", additionalProperties: true },
    },
  },
  parseInput(params): RawContributeInput {
    const payload = requireString(params, "payload");
    const out: RawContributeInput = { payload };
    if (typeof params.mime_type === "string") out.mime_type = params.mime_type;
    if (typeof params.source_ref === "object" && params.source_ref !== null && !Array.isArray(params.source_ref)) {
      out.source_ref = params.source_ref as Record<string, unknown>;
    }
    return out;
  },
  async handle(ctx: ToolContext, input): Promise<ToolResult> {
    const body = Buffer.from(input.payload, "utf8");
    const result = await ctx.raw.ingest(ctx.ctx, {
      sourceType: "agent_contributed",
      sourceRef: {
        agent_id: ctx.agent.id,
        agent_role: ctx.agent.role,
        ...(input.source_ref ?? {}),
      },
      body,
      ...(input.mime_type !== undefined ? { mimeType: input.mime_type } : {}),
    });
    return {
      payload: result,
      summary:
        `Raw artifact stored as \`${result.rawId}\`.\n` +
        `sha256: \`${result.sha256}\`\n` +
        `bytes: ${result.bytes}\n` +
        `deduplicated: ${result.deduplicated ? "yes (existing artifact returned)" : "no"}\n\n` +
        `Any Ledger entities derived from this artifact will be tagged ` +
        `\`provenance=agent_contributed\` with confidence ≤ 0.5.`,
    };
  },
};

export const rawTools: Tool[] = [rawContributeTool as unknown as Tool];
