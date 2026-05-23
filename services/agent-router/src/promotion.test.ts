import { describe, expect, it } from "vitest";
import { StaticPromotionPolicy, ALL_SHADOWED } from "./promotion.js";

describe("StaticPromotionPolicy (graduated rollout)", () => {
  it("shadows every agent by default", () => {
    expect(ALL_SHADOWED.isLive("treasury")).toBe(false);
    expect(ALL_SHADOWED.isRailAllowed("treasury", "ach")).toBe(false);
    expect(new StaticPromotionPolicy().isLive("payment")).toBe(false);
  });

  it("promotes one agent at a time with its rail allowlist", () => {
    const p = new StaticPromotionPolicy({ liveAgents: { savings: ["ach"] } });
    expect(p.isLive("savings")).toBe(true);
    expect(p.isLive("payment")).toBe(false); // others stay shadowed
    expect(p.isRailAllowed("savings", "ach")).toBe(true);
    expect(p.isRailAllowed("savings", "wire")).toBe(false); // rail not allowlisted
    expect(p.isRailAllowed("payment", "ach")).toBe(false); // not live at all
  });
});
