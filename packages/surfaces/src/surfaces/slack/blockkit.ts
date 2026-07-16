import type { Proposal } from "../../proposal/schema.js";
import { sanitizeProposalForSurface } from "../../proposal/sanitize.js";

/**
 * Builds the Slack Block Kit approval card. Pure: takes a proposal, returns
 * blocks. No network. Easy to snapshot test.
 *
 * The action_id values encode proposal id and tenant so the interaction handler
 * can reconstruct an IncomingDecision without server-side session state.
 */
const SEVERITY_ICON: Record<Proposal["severity"], string> = {
  info: ":information_source:",
  warning: ":warning:",
  critical: ":rotating_light:",
};

const AGENT_LABEL: Record<Proposal["agent"], string> = {
  invoice: "Invoice Agent",
  collections: "Collections Agent",
  cash: "Cash Agent",
  close: "Close Agent",
};

export function buildApprovalCard(p: Proposal): unknown[] {
  const proposal = sanitizeProposalForSurface(p, "slack");
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${SEVERITY_ICON[proposal.severity]} ${proposal.title}` },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*${AGENT_LABEL[proposal.agent]}*` },
        { type: "mrkdwn", text: `Expires <!date^${epoch(proposal.expiresAt)}^{time}|soon>` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: proposal.claim } },
  ];

  if (proposal.evidence.length > 0) {
    blocks.push({
      type: "section",
      fields: proposal.evidence.slice(0, 10).map((e) => ({
        type: "mrkdwn",
        text: e.href ? `*${e.label}*\n<${e.href}|${e.value}>` : `*${e.label}*\n${e.value}`,
      })),
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Recommended:* ${proposal.action.summary}` },
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "Approve" },
        action_id: encodeAction("approve", proposal),
        value: proposal.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Hold" },
        action_id: encodeAction("reject", proposal),
        value: proposal.id,
      },
    ],
  });

  return blocks;
}

/** action_id pattern: brain:<decision>:<tenantId>:<proposalId> */
export function encodeAction(decision: "approve" | "reject", p: Proposal): string {
  return `brain:${decision}:${p.tenantId}:${p.id}`;
}

export function decodeAction(
  actionId: string,
): { decision: "approved" | "rejected"; tenantId: string; proposalId: string } | null {
  const parts = actionId.split(":");
  if (parts.length !== 4 || parts[0] !== "brain") return null;
  const [, verb, tenantId, proposalId] = parts as [string, string, string, string];
  if (verb !== "approve" && verb !== "reject") return null;
  return {
    decision: verb === "approve" ? "approved" : "rejected",
    tenantId,
    proposalId,
  };
}

function epoch(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}
