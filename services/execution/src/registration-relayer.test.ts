import { describe, expect, it } from "vitest";
import { UnconfiguredRegistrationRelayer } from "./registration-relayer.js";

describe("UnconfiguredRegistrationRelayer — RFC 0002 Phase C (fail-closed)", () => {
  it("reports configured=false", () => {
    expect(new UnconfiguredRegistrationRelayer().configured).toBe(false);
  });

  it("rejects submitRegistration so an agent is never auto-activated", async () => {
    const relayer = new UnconfiguredRegistrationRelayer();
    await expect(
      relayer.submitRegistration({
        agentId: "agent_x",
        tenantId: "tnt_x",
        onchainAddress: "0x" + "ab".repeat(20),
        scopeHash: "00".repeat(32),
      }),
    ).rejects.toThrow(/not configured/i);
  });
});
