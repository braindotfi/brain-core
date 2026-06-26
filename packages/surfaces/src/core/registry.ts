import type { SurfaceAdapter } from "../surfaces/surface.js";
import type { SurfaceName } from "./ports.js";

/** Holds the set of enabled surface adapters and looks them up by name. */
export class SurfaceRegistry {
  private readonly adapters = new Map<SurfaceName, SurfaceAdapter>();

  register(adapter: SurfaceAdapter): this {
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  get(name: SurfaceName): SurfaceAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`No surface adapter registered for "${name}"`);
    return adapter;
  }

  has(name: SurfaceName): boolean {
    return this.adapters.has(name);
  }

  list(): SurfaceName[] {
    return [...this.adapters.keys()];
  }
}
