/**
 * Canonical prompt templates. The client interpolates the arguments and
 * calls the `wiki.question` tool with the result. Brain's reasoning
 * grounds the answer in the Ledger; the prompt is a convenience for
 * generic MCP clients.
 */

import { brainError } from "@brain/api/shared";
import type {
  PromptDescriptor,
  PromptGetResult,
  PromptListResult,
} from "./types.js";

interface PromptDef {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  /** Function from filled args → user-message text. */
  render(args: Record<string, string>): string;
}

const PROMPTS: ReadonlyArray<PromptDef> = [
  {
    name: "wiki.question.cash_flow_summary",
    description: "Ask Brain to summarize cash flow over a period.",
    arguments: [
      {
        name: "period",
        description: "A human-readable period, e.g. 'this month', 'Q1 2026', '2026-04'.",
        required: true,
      },
    ],
    render: (args) =>
      `What is the cash flow summary for ${args.period}? Include inflow, outflow, net, and the top counterparties by direction.`,
  },
  {
    name: "wiki.question.bills_due",
    description: "List bills due in the next N days.",
    arguments: [
      {
        name: "days",
        description: "Number of days ahead to look. Default 7.",
        required: false,
      },
    ],
    render: (args) =>
      `What bills are due in the next ${args.days ?? "7"} days? Group by counterparty and flag any overdue.`,
  },
  {
    name: "wiki.question.spending_change",
    description: "Explain why spending changed in a period.",
    arguments: [
      {
        name: "period",
        description: "Period to analyze (e.g. 'this month', '2026-04').",
        required: true,
      },
    ],
    render: (args) =>
      `Why did spending change in ${args.period}? Compare against the prior comparable period and identify the top movers.`,
  },
  {
    name: "wiki.question.invoice_status",
    description: "Check the status of a specific invoice.",
    arguments: [
      {
        name: "invoice_number",
        description: "The invoice number as printed on the invoice (e.g. INV-1042).",
        required: true,
      },
    ],
    render: (args) =>
      `What is the status of invoice ${args.invoice_number}? Has it been paid in full, partially, or not at all? Cite the linked transaction(s).`,
  },
  {
    name: "wiki.question.subscriptions",
    description: "List active subscriptions and which can be cancelled.",
    arguments: [],
    render: () =>
      "List all active subscriptions. For each, include the monthly cost, the recurrence rule, and a recommendation on whether it could be cancelled (based on usage signals or duplication).",
  },
];

export function listPrompts(): PromptListResult {
  return {
    prompts: PROMPTS.map((p): PromptDescriptor => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  };
}

export function getPrompt(name: string, args: Record<string, string>): PromptGetResult {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (prompt === undefined) {
    throw brainError("request_params_invalid", `unknown prompt: ${name}`, {
      details: { name, available: PROMPTS.map((p) => p.name) },
    });
  }
  // Validate required args.
  for (const arg of prompt.arguments) {
    if (arg.required && (args[arg.name] === undefined || args[arg.name] === "")) {
      throw brainError("request_params_invalid", `argument '${arg.name}' is required`, {
        details: { prompt: name, missing: arg.name },
      });
    }
  }
  const text = prompt.render(args);
  return {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: { type: "text", text },
      },
    ],
  };
}
