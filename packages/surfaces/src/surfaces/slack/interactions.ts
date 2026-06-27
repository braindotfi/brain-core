import type { IncomingDecision } from "../../core/types.js";
import { decodeAction } from "./blockkit.js";

/**
 * Normalizes a Slack interactive payload (button click) into the surface-agnostic
 * IncomingDecision the ApprovalService expects.
 *
 * Wire this behind a request handler that has ALREADY verified the Slack request
 * signature (X-Slack-Signature). Signature verification is non-negotiable and is
 * left to the host app, see CODEX_PROMPT.md.
 */
export interface SlackInteractionPayload {
  user: { id: string };
  channel?: { id: string };
  message?: { ts: string };
  response_url?: string;
  actions: Array<{ action_id: string; value: string }>;
}

export function toIncomingDecision(payload: SlackInteractionPayload): {
  decision: IncomingDecision;
  deliveredRef?: string | undefined;
  responseUrl?: string | undefined;
} | null {
  const action = payload.actions[0];
  if (!action) return null;

  const decoded = decodeAction(action.action_id);
  if (!decoded) return null;

  const context: Record<string, string> = {};
  if (payload.channel?.id) context.to = payload.channel.id;
  if (payload.message?.ts) context.messageTs = payload.message.ts;

  return {
    decision: {
      surface: "slack",
      proposalId: decoded.proposalId,
      tenantId: decoded.tenantId,
      externalActorId: payload.user.id,
      decision: decoded.decision,
      context,
    },
    deliveredRef: payload.message?.ts,
    responseUrl: payload.response_url,
  };
}
