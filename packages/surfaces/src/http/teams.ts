import type { ConversationReference } from "botbuilder";
import type { ApprovalService } from "../core/approval.js";
import { toIncomingDecision } from "../surfaces/teams/adapter.js";
import type { TeamsSubmitData } from "../surfaces/teams/adaptivecard.js";

export interface VerifiedTeamsSubmit {
  submit?: TeamsSubmitData | undefined;
  aadObjectId?: string | undefined;
  aadTenantId: string;
  serviceUrl?: string | undefined;
  conversationId: string;
  conversationRef: string;
  conversationReference?: Partial<ConversationReference> | undefined;
  activityId?: string | undefined;
}

export interface TeamsActivityVerifier {
  verify(input: {
    authorization: string | undefined;
    rawBody: string | Buffer;
  }): Promise<VerifiedTeamsSubmit | null>;
}

export interface TeamsSubmitRequest {
  authorization?: string | undefined;
  rawBody: string | Buffer;
  verifier: TeamsActivityVerifier;
  trustedBrainTenantId: string;
  approvals: ApprovalService;
}

export interface TeamsSubmitResponse {
  status: number;
  body: string;
}

export async function handleTeamsSubmit(request: TeamsSubmitRequest): Promise<TeamsSubmitResponse> {
  const verified = await request.verifier.verify({
    authorization: request.authorization,
    rawBody: request.rawBody,
  });
  if (!verified) return { status: 401, body: "unauthorized" };

  if (verified.submit === undefined || verified.aadObjectId === undefined) {
    return { status: 400, body: "unknown teams action" };
  }

  const normalized = toIncomingDecision({
    submit: verified.submit,
    aadObjectId: verified.aadObjectId,
    trustedTenantId: request.trustedBrainTenantId,
    conversationRef: verified.conversationRef,
    ...(verified.activityId !== undefined ? { activityId: verified.activityId } : {}),
  });
  if (!normalized) return { status: 403, body: "teams tenant mismatch" };

  const outcome = await request.approvals.handle(normalized.decision, normalized.deliveredRef);
  return { status: 200, body: outcome.status };
}
