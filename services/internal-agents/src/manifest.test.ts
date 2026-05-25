import { describe, expect, it } from "vitest";
import { validateManifest, type AgentManifest } from "@brain/schemas";
import { internalAgentCatalog, manifestFor, allManifests } from "./registry.js";
import { checkManifestForRegistration, computeManifestScopeHash } from "./registration.js";

describe("H-15 agent manifests", () => {
  it("derives a schema-valid manifest for every internal agent", () => {
    for (const def of internalAgentCatalog) {
      const m = manifestFor(def.agent_key);
      expect(m, def.agent_key).not.toBeNull();
      expect(
        validateManifest(m),
        `${def.agent_key}: ${JSON.stringify(validateManifest(m))}`,
      ).toEqual([]);
      expect(m?.can_execute).toBe(false); // never executes (MVP)
      expect(m?.confidence_output.returns_confidence).toBe(true);
    }
    expect(allManifests().length).toBe(internalAgentCatalog.length);
  });

  it("manifestFor returns null for an unknown agent", () => {
    expect(manifestFor("nope")).toBeNull();
  });

  it("a money-mover manifest exposes proposable actions from its action maps", () => {
    const savings = manifestFor("savings");
    expect(savings?.can_propose).toContain("recommend_savings_transfer");
  });
});

describe("validateManifest", () => {
  it("rejects a non-object", () => {
    expect(validateManifest(null).length).toBeGreaterThan(0);
    expect(validateManifest("x").length).toBeGreaterThan(0);
  });

  it("rejects can_execute:true (MVP invariant)", () => {
    const m = manifestFor("savings") as AgentManifest;
    const problems = validateManifest({ ...m, can_execute: true });
    expect(problems).toContain("can_execute must be false (MVP)");
  });

  it("rejects a missing agent_key", () => {
    const m = manifestFor("savings") as AgentManifest;
    const { agent_key: _omit, ...rest } = m;
    expect(validateManifest(rest).length).toBeGreaterThan(0);
  });
});

describe("checkManifestForRegistration (MCP external-agent registration)", () => {
  const manifest = manifestFor("savings") as AgentManifest;
  const correct = computeManifestScopeHash(manifest);

  it("accepts a valid manifest whose scope hash matches the on-chain attestation", () => {
    const r = checkManifestForRegistration(manifest, correct);
    expect(r.ok).toBe(true);
    expect(r.scopeHashMatches).toBe(true);
  });

  it("rejects when the on-chain scope hash differs (→ agent_manifest_invalid)", () => {
    const r = checkManifestForRegistration(manifest, "0xdeadbeef");
    expect(r.ok).toBe(false);
    expect(r.scopeHashMatches).toBe(false);
    expect(r.computedScopeHash).toBe(correct); // still computed, just mismatched
  });

  it("rejects a malformed manifest before hashing", () => {
    const r = checkManifestForRegistration({ agent_key: "" }, correct);
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.computedScopeHash).toBeNull();
  });

  it("the scope hash is deterministic + canonical (key order independent)", () => {
    const reordered = { ...manifest, confidence_output: { ...manifest.confidence_output } };
    expect(computeManifestScopeHash(reordered)).toBe(correct);
  });
});
