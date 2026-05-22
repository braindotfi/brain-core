import { describe, expect, it } from "vitest";
import { capabilityHash } from "@brain/shared";
import { internalAgentCatalog } from "./registry.js";
import { buildInternalAgentRegistration, buildInternalAgentRegistrations } from "./registration.js";
import { collectionsDefinition } from "./collections/definition.js";

describe("buildInternalAgentRegistration", () => {
  it("derives capability hashes, agent id hash, and scope hash", () => {
    const reg = buildInternalAgentRegistration(collectionsDefinition);
    expect(reg.agent_key).toBe("collections");
    expect(reg.provenance).toBe("internal");
    expect(reg.agent_id_hash).toBe(capabilityHash("collections"));
    expect(reg.scope_hash).toBe(capabilityHash("collections_followup"));
    expect(reg.capabilities).toEqual([
      { name: "collections_followup", hash: capabilityHash("collections_followup") },
    ]);
  });
});

describe("buildInternalAgentRegistrations", () => {
  it("produces a registration for every catalog agent with valid bytes32 hashes", () => {
    const regs = buildInternalAgentRegistrations(internalAgentCatalog);
    // One registration per catalog agent (Phase 1 + Phase 2 business library).
    expect(regs.map((r) => r.agent_key).sort()).toEqual(
      internalAgentCatalog.map((d) => d.agent_key).sort(),
    );
    // The Phase 2 business agents are present.
    const keys = new Set(regs.map((r) => r.agent_key));
    for (const key of [
      "payment",
      "subscription",
      "vendor_risk",
      "cash_forecast",
      "dispute",
      "compliance",
      "revenue_intel",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
    for (const r of regs) {
      expect(r.agent_id_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.scope_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.provenance).toBe("internal");
    }
  });
});
