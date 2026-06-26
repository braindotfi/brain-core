/**
 * brain-surfaces: multi-surface delivery and approval for Brain agents.
 *
 * Brain analyzes. You decide. Your systems execute. This package owns the
 * "you decide" surface across Slack, Microsoft Teams, and email. It renders
 * proposals, captures approvals against the Policy layer, anchors them in Audit,
 * and hands approved actions to the customer's own execution rails. It never
 * moves funds.
 */

// Proposal
export * from "./proposal/schema.js";
export { hashProposal, withContentHash } from "./proposal/hash.js";

// Core
export * from "./core/ports.js";
export * from "./core/types.js";
export { SurfaceRegistry } from "./core/registry.js";
export { Dispatcher, isExpired } from "./core/dispatcher.js";
export { ApprovalService } from "./core/approval.js";
export type { ApprovalOutcome } from "./core/approval.js";

// Surfaces
export type { SurfaceAdapter } from "./surfaces/surface.js";
export { SlackAdapter } from "./surfaces/slack/adapter.js";
export type { SlackClient } from "./surfaces/slack/adapter.js";
export { TeamsAdapter } from "./surfaces/teams/adapter.js";
export type { TeamsClient } from "./surfaces/teams/adapter.js";
export { EmailAdapter } from "./surfaces/email/adapter.js";
export type { EmailClient } from "./surfaces/email/adapter.js";
export { signToken, verifyToken } from "./surfaces/email/token.js";
export type { TokenClaims } from "./surfaces/email/token.js";

// Inbound HTTP helpers
export { verifySlackRequest, handleSlackInteraction } from "./http/slack.js";
export type { SlackVerificationResult, SlackInteractionResponse } from "./http/slack.js";
export { handleEmailApproval } from "./http/email.js";
export type { EmailApprovalResponse } from "./http/email.js";
export { handleTeamsSubmit } from "./http/teams.js";
export type { TeamsActivityVerifier, TeamsSubmitResponse } from "./http/teams.js";
export { renderPlainOutcomePage, toPlainOutcome } from "./http/outcome.js";

// Live transport client implementations
export { SlackWebApiClient } from "./clients/slack.js";
export { HttpEmailClient } from "./clients/email.js";
export type { HttpEmailClientOptions } from "./clients/email.js";
export {
  InMemoryConversationReferenceStore,
  TeamsBotFrameworkClient,
  rememberConversationReference,
} from "./clients/teams.js";
export type { ConversationReferenceStore } from "./clients/teams.js";

// Agents
export * from "./agents/catalog.js";

// Config
export { loadConfig } from "./config/env.js";
export type { SurfaceConfig } from "./config/env.js";
