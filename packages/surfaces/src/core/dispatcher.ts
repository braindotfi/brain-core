import type { Proposal } from "../proposal/schema.js";
import { parseProposal } from "../proposal/schema.js";
import { withContentHash } from "../proposal/hash.js";
import type { DeliveryTarget, DeliveryResult } from "./types.js";
import type { SurfaceRegistry } from "./registry.js";

/**
 * Takes a proposal from any agent and fans it out to the requested surfaces.
 * Validates and hashes once, here, so every surface renders the identical,
 * audit-anchored object. Adapters never see an unvalidated proposal.
 */
export class Dispatcher {
  constructor(
    private readonly surfaces: SurfaceRegistry,
    private readonly opts: {
      onDelivered?: (input: { proposal: Proposal; result: DeliveryResult }) => Promise<void>;
    } = {},
  ) {}

  async dispatch(input: unknown, targets: DeliveryTarget[]): Promise<DeliveryResult[]> {
    const proposal: Proposal = withContentHash(parseProposal(input));
    if (isExpired(proposal)) {
      throw new Error(`Proposal ${proposal.id} is already expired, refusing to dispatch`);
    }

    const results = await Promise.allSettled(
      targets.map((t) => this.surfaces.get(t.surface).deliver(proposal, t.to)),
    );

    const mapped = results.map((r, i) => {
      const target = targets[i]!;
      if (r.status === "fulfilled") return r.value;
      return {
        surface: target.surface,
        target: target.to,
        ok: false,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      } satisfies DeliveryResult;
    });

    await Promise.all(
      mapped
        .filter((result) => result.ok && result.ref !== undefined)
        .map((result) => this.opts.onDelivered?.({ proposal, result })),
    );

    return mapped;
  }
}

export function isExpired(p: Proposal): boolean {
  return new Date(p.expiresAt).getTime() <= Date.now();
}
