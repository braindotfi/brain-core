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
export {
  publishAnchor,
  type AnchorBroadcaster,
  type BroadcastInput,
  type BroadcastResult,
  type PublishOptions,
} from "./publisher.js";
