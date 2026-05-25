/**
 * Brain layer-boundary contracts (v0.3 / six-layer model).
 *
 * Type-only barrel: every export here is a TypeScript interface or type.
 * No runtime symbols; consumers can `import type { ILedgerService }
 * from "@brain/api/shared"` without taking a dependency on the
 * implementing workspace.
 *
 * Each interface documents the layer boundary it enforces. Implementers
 * MUST satisfy the interface; CI grep enforces that no service imports
 * across boundaries except via these contracts.
 */

export * from "./types.js";
export * from "./IRawEvidenceService.js";
export * from "./ILedgerService.js";
export * from "./IWikiMemoryService.js";
export * from "./IPolicyService.js";
export * from "./IAgentService.js";
export {
  type AuditEventRecord,
  type AuditAnchorRecord,
  type IAuditService,
} from "./IAuditService.js";
export * from "./IReconciliationService.js";
export * from "./IPaymentIntentService.js";
export * from "./IApprovalService.js";
export * from "./proof.js";
export * from "./agent-run.js";
export * from "./agent-output.js";
