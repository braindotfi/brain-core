import { describe, expect, it } from "vitest";
import { capabilityHash } from "@brain/shared";
import { internalAgentCatalog } from "./agents/registry.js";
import { buildInternalAgentRegistration, buildInternalAgentRegistrations } from "./registration.js";
import { collectionsDefinition } from "./agents/collections/definition.js";

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
    expect(regs.map((r) => r.agent_key).sort()).toEqual([
      "collections",
      "reconciliation",
      "treasury",
    ]);
    for (const r of regs) {
      expect(r.agent_id_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.scope_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.provenance).toBe("internal");
    }
  });
});
