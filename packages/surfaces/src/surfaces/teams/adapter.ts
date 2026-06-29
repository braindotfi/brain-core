import type { Proposal } from "../../proposal/schema.js";
import type { SurfaceAdapter } from "../surface.js";
import type { DeliveryResult, IncomingDecision } from "../../core/types.js";
import { buildAdaptiveCard, decodeSubmit } from "./adaptivecard.js";
import type { TeamsSubmitData } from "./adaptivecard.js";

/**
 * Teams delivery via the Bot Framework. The "to" target is a conversation
 * reference id that the host resolves to a ConversationReference for proactive
 * messaging. The send client is injected to keep Bot Framework wiring in the
 * host app.
 */
export interface TeamsClient {
  sendCard(args: {
    tenantId: string;
    conversationRef: string;
    card: Record<string, unknown>;
  }): Promise<{ ok: boolean; activityId?: string; error?: string }>;
  updateCard(args: {
    tenantId: string;
    conversationRef: string;
    activityId: string;
    card: Record<string, unknown>;
  }): Promise<{ ok: boolean; error?: string }>;
}

export class TeamsAdapter implements SurfaceAdapter {
  readonly name = "teams" as const;

  constructor(private readonly client: TeamsClient) {}

  async deliver(proposal: Proposal, to: string): Promise<DeliveryResult> {
    const card = buildAdaptiveCard(proposal);
    const res = await this.client.sendCard({
      tenantId: proposal.tenantId,
      conversationRef: to,
      card,
    });
    return {
      surface: this.name,
      target: to,
      ok: res.ok,
      ref: res.activityId,
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
    const text =
      input.decision === "approved"
        ? `Approved by ${input.actorLabel}. Handed off for execution.`
        : input.decision === "rejected"
          ? `Held by ${input.actorLabel}. No action taken.`
          : "Expired. No action taken.";
    await this.client.updateCard({
      tenantId: input.proposal.tenantId,
      conversationRef: input.to,
      activityId: input.ref,
      card: {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.5",
        body: [
          { type: "TextBlock", text: input.proposal.title, weight: "Bolder", wrap: true },
          { type: "TextBlock", text, wrap: true },
        ],
      },
    });
  }
}

/**
 * Normalizes a Teams Action.Submit activity into an IncomingDecision. Call only
 * after the host has authenticated the activity via the Bot Framework adapter.
 * The verified user aad object id is the externalActorId.
 */
export function toIncomingDecision(input: {
  submit: TeamsSubmitData;
  aadObjectId: string;
  conversationRef: string;
  activityId?: string;
}): { decision: IncomingDecision; deliveredRef?: string | undefined } | null {
  const decoded = decodeSubmit(input.submit);
  if (!decoded) return null;
  return {
    decision: {
      surface: "teams",
      proposalId: decoded.proposalId,
      tenantId: decoded.tenantId,
      externalActorId: input.aadObjectId,
      decision: decoded.decision,
      context: { to: input.conversationRef },
    },
    deliveredRef: input.activityId,
  };
}
