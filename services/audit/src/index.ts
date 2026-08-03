/**
 * @brain/audit
 *
 * Append-only, Merkle-anchored audit log. 5 endpoints per
 * Brain_API_Specification.yaml §Audit.
 */

export const SERVICE_NAME = "brain-audit" as const;

export { buildAuditApp, type BuildAuditAppOptions } from "./server.js";
export type { AuditDeps } from "./deps.js";
export { MAX_ANCHOR_WINDOW_MS, nextAnchorWindow, type AnchorWindow } from "./anchorWindow.js";
export * from "./merkle.js";
export { verifyInclusion } from "./verify.js";
export {
  createPendingAnchor,
  publishAnchor,
  publishPendingAnchorBatch,
  publishPendingAnchor,
  type AnchorBatchBroadcaster,
  type AnchorBroadcaster,
  type BroadcastBatchResult,
  type BroadcastInput,
  type BroadcastResult,
  type PublishPendingAnchorBatchSummary,
  type PublishOptions,
} from "./publisher.js";
export type { AuditAnchorRow } from "./repository.js";
export { registerAuditRoutes } from "./routes.js";
export { registerWebhookRoutes, type WebhookRouteDeps } from "./webhook-routes.js";
export {
  reconcileOrphanedAnchors,
  startAnchorReconciler,
  type AnchorEventReader,
  type ReconcilerDeps,
  type ReconcileOptions,
  type AnchorReconciler,
} from "./reconciler.js";
export {
  checkAuditConsistency,
  verifyContentHashCursor,
  verifyAnchorRoots,
  reportVerifierHealth,
  startAuditConsistencyVerifier,
  CONTENT_HASH_VERIFIER_NAME,
  ANCHOR_ROOT_VERIFIER_NAME,
  type AuditConsistencyDeps,
  type AuditConsistencyResult,
  type ContentHashVerifyResult,
  type AnchorRootVerifyResult,
  type AuditVerifierHealth,
  type AnchorRootVerifierHealth,
  type AuditConsistencyVerifier,
} from "./audit-consistency.js";
export {
  runWebhookDispatchCycle,
  startWebhookDispatchWorker,
  type WebhookDispatchWorkerDeps,
  type CycleResult as WebhookDispatchCycleResult,
} from "./webhook-dispatch-worker.js";
