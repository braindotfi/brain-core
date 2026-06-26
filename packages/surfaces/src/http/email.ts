import type { ApprovalService } from "../core/approval.js";
import { toIncomingDecision } from "../surfaces/email/adapter.js";
import { verifyToken, type TokenClaims } from "../surfaces/email/token.js";
import { renderPlainOutcomePage, toPlainOutcome } from "./outcome.js";

export interface EmailApprovalRequest {
  method?: "GET" | "HEAD" | "POST" | undefined;
  url: string | URL;
  body?: string | Buffer | URLSearchParams | undefined;
  tokenSecret: string;
  approvals: ApprovalService;
  loadProposalTitle?:
    | ((input: { tenantId: string; proposalId: string }) => Promise<string | null>)
    | undefined;
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
  const method = request.method ?? "GET";

  if (method === "GET" || method === "HEAD") {
    const token = url.searchParams.get("t");
    if (!token) return page("unknown", 400, method);

    const claims = verifyToken(token, request.tokenSecret);
    if (!claims) return page("unknown", 400, method);

    const title =
      (await request.loadProposalTitle?.({
        tenantId: claims.tenantId,
        proposalId: claims.proposalId,
      })) ?? `Proposal ${claims.proposalId}`;

    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body:
        method === "HEAD"
          ? ""
          : renderConfirmationPage({ token, claims, title, action: url.pathname }),
    };
  }

  if (method !== "POST") return page("unknown", 405);

  const token = readFormToken(request.body);
  if (!token) return page("unknown", 400);

  const decision = toIncomingDecision({ token, tokenSecret: request.tokenSecret });
  if (!decision) return page("unknown", 400);
  const outcome = await request.approvals.handle(decision);
  return page(toPlainOutcome(outcome), 200);
}

function page(
  outcome: Parameters<typeof renderPlainOutcomePage>[0],
  status: number,
  method: "GET" | "HEAD" | "POST" = "GET",
): EmailApprovalResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: method === "HEAD" ? "" : renderPlainOutcomePage(outcome),
  };
}

function readFormToken(body: EmailApprovalRequest["body"]): string | null {
  if (!body) return null;
  const params =
    body instanceof URLSearchParams
      ? body
      : new URLSearchParams(Buffer.isBuffer(body) ? body.toString("utf8") : body);
  return params.get("t");
}

function renderConfirmationPage(input: {
  token: string;
  claims: TokenClaims;
  title: string;
  action: string;
}): string {
  const decision = input.claims.decision === "approved" ? "approve" : "hold";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Confirm Brain Approval</title></head><body><main><h1>Confirm ${escapeHtml(decision)}</h1><p>${escapeHtml(input.title)}</p><form method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="t" value="${escapeHtml(input.token)}"><button type="submit">Confirm ${escapeHtml(decision)}</button></form></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
