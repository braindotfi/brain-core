/**
 * Barrel + live-promotion-config coverage (fix/main-green): importing the
 * package entrypoint executes every re-export in index.ts, and asserting the
 * shape of LIVE_AGENTS exercises promotion-config.ts. Both were at 0%.
 */

import { describe, expect, it } from "vitest";
import * as pkg from "./index.js";
import { LIVE_AGENTS } from "./index.js";

describe("@brain/agent-router barrel", () => {
  it("re-exports the public surface", () => {
    expect(pkg.AgentRouter).toBeTypeOf("function");
    expect(pkg.ActionResolver).toBeTypeOf("function");
    expect(pkg.AgentRunService).toBeTypeOf("function");
    expect(pkg.registerAgentRouterRoutes).toBeTypeOf("function");
    expect(pkg.registerAgentApiRoutes).toBeTypeOf("function");
    expect(pkg.StaticPromotionPolicy).toBeTypeOf("function");
    expect(pkg.routeAndPropose).toBeTypeOf("function");
    expect(pkg.createAgentRouteWorker).toBeTypeOf("function");
    expect(pkg.REQUESTED_ACTION_KEY).toBeTypeOf("string");
    expect(pkg.ALL_SHADOWED).toBeDefined();
  });
});

describe("LIVE_AGENTS promotion config", () => {
  it("promotes all 19 internal agents to ach + onchain rails", () => {
    // liveAgents is typed as optional on PromotionConfig; LIVE_AGENTS sets it.
    const live = LIVE_AGENTS.liveAgents ?? {};
    const agents = Object.keys(live);
    expect(agents).toHaveLength(19);
    for (const rails of Object.values(live)) {
      expect(rails).toEqual(["ach", "onchain"]);
    }
  });

  it("is consumable by StaticPromotionPolicy without throwing", () => {
    const policy = new pkg.StaticPromotionPolicy(LIVE_AGENTS);
    expect(policy).toBeInstanceOf(pkg.StaticPromotionPolicy);
  });
});
