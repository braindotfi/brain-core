import type { BrainCorePorts } from "@brain/surfaces";
import type { CoreServices } from "../internal/services.js";
import { CoreIdentityResolver } from "./identity.js";
import { CorePolicyGate } from "./policy.js";
import { CoreAuditAnchor } from "./audit.js";
import { CoreApprovalRecorder } from "./approvals.js";
import { CoreExecutionHandoff } from "./execution.js";
import { CoreApprovalDecisionStore } from "./decisions.js";

/**
 * Assembles the four surface ports from brain-core's existing services. This is
 * the single place where brain-core fulfils the surface boundary. The surface
 * package depends on none of this. The dependency points one way only:
 * core -> surfaces.
 */
export function buildBrainCorePorts(services: CoreServices): BrainCorePorts {
  return {
    identity: new CoreIdentityResolver(services.identity),
    policy: new CorePolicyGate(services.policy),
    audit: new CoreAuditAnchor(services.audit),
    approvals: new CoreApprovalRecorder(services.approvals),
    execution: new CoreExecutionHandoff(services.execution),
    decisions: new CoreApprovalDecisionStore(services.decisions),
  };
}

export { CoreIdentityResolver } from "./identity.js";
export { CorePolicyGate } from "./policy.js";
export { CoreAuditAnchor } from "./audit.js";
export { CoreApprovalRecorder } from "./approvals.js";
export { CoreExecutionHandoff } from "./execution.js";
export { CoreApprovalDecisionStore } from "./decisions.js";
