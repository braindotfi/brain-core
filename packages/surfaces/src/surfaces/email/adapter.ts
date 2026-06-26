import type { Proposal } from "../../proposal/schema.js";
import type { SurfaceAdapter } from "../surface.js";
import type { DeliveryResult, IncomingDecision } from "../../core/types.js";
import { renderEmail } from "./template.js";
import type { EmailRenderOptions } from "./template.js";
import { verifyToken } from "./token.js";

/** Minimal send interface. Back it with the customer's ESP in production. */
export interface EmailClient {
  send(args: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }>;
}

export class EmailAdapter implements SurfaceAdapter {
  readonly name = "email" as const;

  constructor(
    private readonly client: EmailClient,
    private readonly opts: Omit<EmailRenderOptions, "recipient">,
  ) {}

  async deliver(proposal: Proposal, to: string): Promise<DeliveryResult> {
    const email = renderEmail(proposal, { ...this.opts, recipient: to });
    const res = await this.client.send({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    return {
      surface: this.name,
      target: to,
      ok: res.ok,
      ref: res.messageId,
      error: res.error,
    };
  }

  async updateDecision(): Promise<void> {
    // Email cannot be updated in place. The hosted approval page shows the
    // outcome instead. Intentional no-op.
  }
}

/**
 * Decodes the approval route hit (the link click) into an IncomingDecision.
 * Token verification proves the link's integrity. The recipient in the token is
 * the external actor id, which still flows through identity plus policy.
 */
export function toIncomingDecision(input: {
  token: string;
  tokenSecret: string;
}): IncomingDecision | null {
  const claims = verifyToken(input.token, input.tokenSecret);
  if (!claims) return null;
  return {
    surface: "email",
    proposalId: claims.proposalId,
    tenantId: claims.tenantId,
    externalActorId: claims.recipient,
    decision: claims.decision,
    context: { recipient: claims.recipient },
  };
}
