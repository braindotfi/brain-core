import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_FEATURE_NAMES,
  PHASE_ONE_COMMERCIAL_FEATURE_FLAGS,
  countsTowardAgentCapacity,
  type CommercialAgentInstanceContract,
} from "./contracts.js";

describe("commercial Phase 1 contracts", () => {
  it("keeps every commercial capability off", () => {
    expect(COMMERCIAL_FEATURE_NAMES).toHaveLength(8);
    expect(Object.values(PHASE_ONE_COMMERCIAL_FEATURE_FLAGS)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("counts only configured active customer agent instances", () => {
    const active = agent({ lifecycleState: "active" });
    expect(countsTowardAgentCapacity(active)).toBe(true);
    expect(countsTowardAgentCapacity(agent({ lifecycleState: "draft" }))).toBe(false);
    expect(countsTowardAgentCapacity(agent({ lifecycleState: "capacity_paused" }))).toBe(false);
    expect(countsTowardAgentCapacity(agent({ lifecycleState: "deleted" }))).toBe(false);
    expect(countsTowardAgentCapacity(agent({ systemBootstrap: true }))).toBe(false);
    expect(countsTowardAgentCapacity(agent({ demoInstance: true }))).toBe(false);
  });
});

function agent(
  overrides: Partial<CommercialAgentInstanceContract>,
): CommercialAgentInstanceContract {
  return {
    id: "cmai_01K123456789ABCDEFGHJKMNPQ",
    tenantId: "tnt_01K123456789ABCDEFGHJKMNPQ",
    entityId: "rme_01K123456789ABCDEFGHJKMNPQ",
    runtimeAgentId: "agent_01K123456789ABCDEFGHJKMNPQ",
    lifecycleState: "active",
    systemBootstrap: false,
    demoInstance: false,
    version: 1,
    ...overrides,
  };
}
