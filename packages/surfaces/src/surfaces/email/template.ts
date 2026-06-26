import type { Proposal } from "../../proposal/schema.js";
import { signToken } from "./token.js";

const AGENT_LABEL: Record<Proposal["agent"], string> = {
  invoice: "Invoice Agent",
  collections: "Collections Agent",
  cash: "Cash Agent",
  close: "Close Agent",
};

export interface EmailRenderOptions {
  /** Base URL of the hosted approval route, for example https://app.brain.fi/approve. */
  approvalBaseUrl: string;
  /** Verified recipient address, bound into the token. */
  recipient: string;
  tokenSecret: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderEmail(p: Proposal, opts: EmailRenderOptions): RenderedEmail {
  const exp = Math.floor(new Date(p.expiresAt).getTime() / 1000);
  const link = (decision: "approved" | "rejected"): string => {
    const token = signToken(
      { tenantId: p.tenantId, proposalId: p.id, decision, recipient: opts.recipient, exp },
      opts.tokenSecret,
    );
    return `${opts.approvalBaseUrl}?t=${encodeURIComponent(token)}`;
  };

  const evidenceRows = p.evidence
    .slice(0, 10)
    .map((e) => `<tr><td><strong>${esc(e.label)}</strong></td><td>${esc(e.value)}</td></tr>`)
    .join("");

  const subject = `[Brain ${AGENT_LABEL[p.agent]}] ${p.title}`;

  const html = `<!doctype html><html><body style="font-family:sans-serif;max-width:560px;margin:0 auto">
  <h2>${esc(p.title)}</h2>
  <p style="color:#555">${AGENT_LABEL[p.agent]} • expires ${esc(p.expiresAt)}</p>
  <p>${esc(p.claim)}</p>
  ${evidenceRows ? `<table>${evidenceRows}</table>` : ""}
  <p><strong>Recommended:</strong> ${esc(p.action.summary)}</p>
  <p>
    <a href="${link("approved")}" style="background:#FF4438;color:#fff;padding:10px 18px;text-decoration:none">Approve</a>
    &nbsp;
    <a href="${link("rejected")}" style="padding:10px 18px;text-decoration:none">Hold</a>
  </p>
  <p style="color:#888;font-size:12px">Approving records your decision and hands the action to your own systems. Brain never moves funds.</p>
  </body></html>`;

  const text = `${p.title}\n\n${p.claim}\n\nRecommended: ${p.action.summary}\n\nApprove: ${link("approved")}\nHold: ${link("rejected")}`;

  return { subject, html, text };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
