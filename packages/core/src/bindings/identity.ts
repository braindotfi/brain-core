import type { IdentityResolver, ResolvedActor, SurfaceName } from "@brain/surfaces";
import type { TenantIdentityStore } from "../internal/services.js";

/**
 * Binds the surface IdentityResolver port to brain-core's RLS-scoped identity
 * store. No workspace-level trust: every lookup is tenant scoped, and an
 * unprovisioned external identity returns null.
 */
export class CoreIdentityResolver implements IdentityResolver {
  constructor(private readonly store: TenantIdentityStore) {}

  async resolve(input: {
    tenantId: string;
    surface: SurfaceName;
    externalId: string;
  }): Promise<ResolvedActor | null> {
    const actor = await this.store.lookupActor(input);
    if (!actor) return null;
    return { actorId: actor.actorId, roles: actor.roles };
  }
}
