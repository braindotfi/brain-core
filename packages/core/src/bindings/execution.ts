import type { ExecutionHandoff, Proposal, ActorId } from "@brain/surfaces";
import type { ExecutionQueue } from "../internal/services.js";

/**
 * Binds the surface ExecutionHandoff port to brain-core's execution queue.
 *
 * This is the only path from an approved proposal to the customer's execution
 * rails, and it stops at the queue. Brain enqueues. The downstream worker carries
 * the action out under the customer's own credentials. Nothing here moves funds,
 * and the enqueue is idempotent on proposal id so a double click cannot
 * double-execute.
 */
export class CoreExecutionHandoff implements ExecutionHandoff {
  constructor(private readonly queue: ExecutionQueue) {}

  async enqueue(input: { proposal: Proposal; actorId: ActorId }): Promise<void> {
    await this.queue.enqueueIdempotent({
      proposalId: input.proposal.id,
      proposal: input.proposal,
      actorId: input.actorId,
    });
  }
}
