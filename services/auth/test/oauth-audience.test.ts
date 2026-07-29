/**
 * Unit test for resolveAudience (RFC 8707 section 2.2), the audience
 * expression shared by both grant paths in src/routes/oauth.ts so they
 * cannot drift apart.
 */

import { describe, expect, it } from "vitest";
import { resolveAudience } from "../src/routes/oauth.js";

const deps = {
  authAudience: "brain-api",
  mcpPublicResourceUrl: "https://mcp.brain.fi",
};

describe("resolveAudience", () => {
  it("a matching resource yields the two-element array", () => {
    expect(resolveAudience(deps, "https://mcp.brain.fi")).toEqual([
      "brain-api",
      "https://mcp.brain.fi",
    ]);
  });

  it("an absent resource yields the bare authAudience", () => {
    expect(resolveAudience(deps, undefined)).toBe("brain-api");
  });

  it("an unrecognized resource does not widen the audience either", () => {
    expect(resolveAudience(deps, "https://not-mcp.example.test")).toBe("brain-api");
  });
});
