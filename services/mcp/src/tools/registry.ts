/**
 * Combined tool registry. The MCP server consumes this when answering
 * `tools/list` and dispatching `tools/call`.
 */

import { agentTools } from "./agent.js";
import { ledgerTools } from "./ledger.js";
import { paymentIntentTools } from "./payment-intent.js";
import { rawTools } from "./raw.js";
import type { Tool } from "./types.js";
import { wikiTools } from "./wiki.js";

export const ALL_TOOLS: ReadonlyArray<Tool> = [
  ...ledgerTools,
  ...wikiTools,
  ...rawTools,
  ...paymentIntentTools,
  ...agentTools,
];

export function findTool(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export function toolDescriptors(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
