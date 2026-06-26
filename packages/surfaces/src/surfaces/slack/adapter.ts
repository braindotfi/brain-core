import type { Proposal } from "../../proposal/schema.js";
import type { SurfaceAdapter } from "../surface.js";
import type { DeliveryResult } from "../../core/types.js";
import { buildApprovalCard } from "./blockkit.js";

/**
 * Slack delivery via chat.postMessage and chat.update. Push model: Brain posts
 * the approval card proactively into an AP channel or DM.
 *
 * The Slack Web API client is injected so this stays testable and so the host
 * app owns token storage. Use @slack/web-api WebClient in production.
 */
export interface SlackClient {
  postMessage(args: {
    channel: string;
    text: string;
    blocks: unknown[];
  }): Promise<{ ok: boolean; ts?: string; error?: string }>;
  update(args: {
    channel: string;
    ts: string;
    text: string;
    blocks: unknown[];
  }): Promise<{ ok: boolean; error?: string }>;
}

export class SlackAdapter implements SurfaceAdapter {
  readonly name = "slack" as const;

  constructor(private readonly client: SlackClient) {}

  async deliver(proposal: Proposal, to: string): Promise<DeliveryResult> {
    const blocks = buildApprovalCard(proposal);
    const res = await this.client.postMessage({
      channel: to,
      text: proposal.title, // fallback for notifications and accessibility
      blocks,
    });
    return {
      surface: this.name,
      target: to,
      ok: res.ok,
      ref: res.ts,
      error: res.error,
    };
  }

  async updateDecision(input: {
    ref: string;
    to: string;
    proposal: Proposal;
    decision: "approved" | "rejected" | "expired";
    actorLabel: string;
  }): Promise<void> {
    const banner = decisionBanner(input.decision, input.actorLabel);
    await this.client.update({
      channel: input.to,
      ts: input.ref,
      text: input.proposal.title,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: input.proposal.title },
        },
        { type: "section", text: { type: "mrkdwn", text: banner } },
      ],
    });
  }
}

function decisionBanner(decision: "approved" | "rejected" | "expired", actorLabel: string): string {
  switch (decision) {
    case "approved":
      return `:white_check_mark: Approved by <@${actorLabel}>. Handed off for execution.`;
    case "rejected":
      return `:no_entry: Held by <@${actorLabel}>. No action taken.`;
    case "expired":
      return ":hourglass: Expired. No action taken.";
  }
}
