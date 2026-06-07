/**
 * @brain/audit
 *
 * Append-only, Merkle-anchored audit log. 5 endpoints per
 * Brain_API_Specification.yaml §Audit.
 */

export const SERVICE_NAME = "brain-audit" as const;

export { buildAuditApp, type BuildAuditAppOptions } from "./server.js";
export type { AuditDeps } from "./deps.js";
export * from "./merkle.js";
export { verifyInclusion } from "./verify.js";
export {
  publishAnchor,
  type AnchorBroadcaster,
  type BroadcastInput,
  type BroadcastResult,
  type PublishOptions,
} from "./publisher.js";
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
  startAuditConsistencyVerifier,
  type AuditConsistencyDeps,
  type AuditConsistencyResult,
  type AuditConsistencyVerifier,
} from "./audit-consistency.js";
export {
  runWebhookDispatchCycle,
  startWebhookDispatchWorker,
  type WebhookDispatchWorkerDeps,
  type CycleResult as WebhookDispatchCycleResult,
} from "./webhook-dispatch-worker.js";
