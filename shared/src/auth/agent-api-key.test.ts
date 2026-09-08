import { describe, expect, it } from "vitest";
import {
  AGENT_API_KEY_PROFILE_SCOPES,
  agentApiKeyHashesEqual,
  generateAgentApiKey,
  hashAgentApiKey,
  parseAgentApiKey,
  scopesMatchAgentApiKeyProfile,
} from "./agent-api-key.js";

describe("agent API key primitives", () => {
  it.each(["test", "live"] as const)("generates and parses a %s exchange key", (environment) => {
    const generated = generateAgentApiKey(environment);
    expect(generated.plaintext).toMatch(
      new RegExp(`^brain_ak_${environment}_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}$`),
    );
    expect(parseAgentApiKey(generated.plaintext)).toEqual({
      id: generated.id,
      environment,
    });
    expect(generated.prefix).toBe(`brain_ak_${environment}_`);
    expect(generated.last4).toBe(generated.plaintext.slice(-4));
  });

  it("rejects malformed and commercial keys", () => {
    expect(parseAgentApiKey("brain_sk_live_not-an-agent-key")).toBeNull();
    expect(parseAgentApiKey("brain_ak_live_short_secret")).toBeNull();
  });

  it("hashes with a dedicated pepper and compares digests safely", () => {
    const key = generateAgentApiKey("test").plaintext;
    const digest = hashAgentApiKey(key, "pepper-one");
    expect(agentApiKeyHashesEqual(digest, hashAgentApiKey(key, "pepper-one"))).toBe(true);
    expect(agentApiKeyHashesEqual(digest, hashAgentApiKey(key, "pepper-two"))).toBe(false);
    expect(agentApiKeyHashesEqual("not-hex", digest)).toBe(false);
  });

  it("pins each profile to its exact scope set", () => {
    expect(AGENT_API_KEY_PROFILE_SCOPES.document_extractor_v1).toEqual(["raw:write"]);
    expect(scopesMatchAgentApiKeyProfile("document_extractor_v1", ["raw:write"])).toBe(true);
    expect(
      scopesMatchAgentApiKeyProfile("document_extractor_v1", ["raw:write", "ledger:read"]),
    ).toBe(false);
  });
});
