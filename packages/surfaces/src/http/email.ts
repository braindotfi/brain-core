import type { ApprovalService } from "../core/approval.js";
import { toIncomingDecision } from "../surfaces/email/adapter.js";
import { renderPlainOutcomePage, toPlainOutcome } from "./outcome.js";

export interface EmailApprovalRequest {
  url: string | URL;
  tokenSecret: string;
  approvals: ApprovalService;
}

export interface EmailApprovalResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function handleEmailApproval(
  request: EmailApprovalRequest,
): Promise<EmailApprovalResponse> {
  const url = typeof request.url === "string" ? new URL(request.url) : request.url;
  const token = url.searchParams.get("t");
  if (!token) return page("unknown", 400);

  const decision = toIncomingDecision({ token, tokenSecret: request.tokenSecret });
  if (!decision) return page("unknown", 400);

  const outcome = await request.approvals.handle(decision);
  return page(toPlainOutcome(outcome), 200);
}

function page(
  outcome: Parameters<typeof renderPlainOutcomePage>[0],
  status: number,
): EmailApprovalResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: renderPlainOutcomePage(outcome),
  };
}
