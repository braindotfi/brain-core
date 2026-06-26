/**
 * @brain/core surface integration entry point.
 *
 * Exposes the four port bindings and the composition root that wires the
 * surface package to brain-core's internal services. brain-core depends on
 * @brain/surfaces. @brain/surfaces depends on nothing here. The dependency is
 * acyclic and one-directional by design.
 */
export { buildBrainCorePorts } from "./bindings/index.js";
export {
  CoreIdentityResolver,
  CorePolicyGate,
  CoreAuditAnchor,
  CoreExecutionHandoff,
} from "./bindings/index.js";

export { buildSurfaceRuntime } from "./composition/surfaceRuntime.js";
export type { SurfaceRuntime, SurfaceClients } from "./composition/surfaceRuntime.js";

export type {
  CoreServices,
  TenantIdentityStore,
  PolicyEngine,
  AuditLog,
  ExecutionQueue,
  ProposalStore,
} from "./internal/services.js";
