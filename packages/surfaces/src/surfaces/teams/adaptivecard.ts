import type { Proposal } from "../../proposal/schema.js";

/**
 * Builds a Teams Adaptive Card (schema 1.5). Pure, like the Slack builder.
 * Action.Submit carries proposal id, tenant, and decision in its data so the
 * activity handler can rebuild an IncomingDecision with no session state.
 */
const AGENT_LABEL: Record<Proposal["agent"], string> = {
  invoice: "Invoice Agent",
  collections: "Collections Agent",
  cash: "Cash Agent",
  close: "Close Agent",
};

export function buildAdaptiveCard(p: Proposal): Record<string, unknown> {
  const body: unknown[] = [
    {
      type: "TextBlock",
      text: p.title,
      weight: "Bolder",
      size: "Large",
      wrap: true,
    },
    {
      type: "TextBlock",
      text: `${AGENT_LABEL[p.agent]} • expires ${p.expiresAt}`,
      isSubtle: true,
      spacing: "None",
      wrap: true,
    },
    { type: "TextBlock", text: p.claim, wrap: true },
  ];

  if (p.evidence.length > 0) {
    body.push({
      type: "FactSet",
      facts: p.evidence.slice(0, 10).map((e) => ({ title: e.label, value: e.value })),
    });
  }

  body.push({
    type: "TextBlock",
    text: `**Recommended:** ${p.action.summary}`,
    wrap: true,
    spacing: "Medium",
  });

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
    actions: [
      {
        type: "Action.Submit",
        title: "Approve",
        style: "positive",
        data: { brainDecision: "approved", tenantId: p.tenantId, proposalId: p.id },
      },
      {
        type: "Action.Submit",
        title: "Hold",
        data: { brainDecision: "rejected", tenantId: p.tenantId, proposalId: p.id },
      },
    ],
  };
}

export interface TeamsSubmitData {
  brainDecision?: "approved" | "rejected";
  tenantId?: string;
  proposalId?: string;
}

export function decodeSubmit(
  data: TeamsSubmitData,
): { decision: "approved" | "rejected"; tenantId: string; proposalId: string } | null {
  if (!data.brainDecision || !data.tenantId || !data.proposalId) return null;
  return {
    decision: data.brainDecision,
    tenantId: data.tenantId,
    proposalId: data.proposalId,
  };
}
