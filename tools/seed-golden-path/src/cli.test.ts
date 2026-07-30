import { describe, expect, it } from "vitest";
import { computeAgentScopeHash, PAYMENT_AGENT_SCOPES } from "@brain/shared";
import { demoAgentScopeHash } from "./demo-agent-scope-hash.js";

describe("demoAgentScopeHash", () => {
  it("equals computeAgentScopeHash(PAYMENT_AGENT_SCOPES), not a tenant-specific SHA-256", () => {
    const expected = computeAgentScopeHash(PAYMENT_AGENT_SCOPES);
    expect(demoAgentScopeHash().toString("hex")).toBe(expected.slice(2));
  });

  it("pins the golden hash so a future formula change is loud", () => {
    // Same value pinned in shared/src/agents/capability.test.ts. If this
    // assertion breaks, the demo seeder has drifted from the canonical
    // agents.scope_hash derivation again.
    expect(`0x${demoAgentScopeHash().toString("hex")}`).toBe(
      "0xe5c560b489fa55c2a55066435093cf43a818e91b1f573b5be27c9df64571a9d4",
    );
  });
});
