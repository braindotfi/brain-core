import type { ExecutionHandoff, Proposal, ActorId, SurfaceName } from "@brain/surfaces";
import type { ExecutionQueue } from "../internal/services.js";

/**
 * Binds the surface ExecutionHandoff port to brain-core's execution queue.
 *
 * This is the only surface path from an approved proposal to core's canonical
 * action service. The service runs the section 6 gate and writes the durable
 * execution outbox. The binding never constructs a parallel rail payload.
 */
export class CoreExecutionHandoff implements ExecutionHandoff {
  constructor(private readonly queue: ExecutionQueue) {}

  async enqueue(input: {
    proposal: Proposal;
    actorId: ActorId;
    externalActorId: string;
    surface: SurfaceName;
  }): Promise<void> {
    await this.queue.enqueueIdempotent({
      proposalId: input.proposal.id,
      proposal: input.proposal,
      actorId: input.actorId,
      externalActorId: input.externalActorId,
      surface: input.surface,
    });
  }
}
