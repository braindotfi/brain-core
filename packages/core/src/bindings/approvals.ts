import type { ActorId, ApprovalRecorder, Proposal, SurfaceName } from "@brain/surfaces";
import type { ApprovalRecorder as CoreApprovalRecorderPort } from "../internal/services.js";

/**
 * Binds post-audit approval signature recording to brain-core.
 * The surface pipeline calls this only after Audit accepts the decision.
 */
export class CoreApprovalRecorder implements ApprovalRecorder {
  constructor(private readonly recorder: CoreApprovalRecorderPort) {}

  async recordApproval(input: {
    proposal: Proposal;
    actorId: ActorId;
    surface: SurfaceName;
    approverRole?: string | undefined;
  }): Promise<{ quorumMet: boolean }> {
    return this.recorder.recordApproval(input);
  }
}
