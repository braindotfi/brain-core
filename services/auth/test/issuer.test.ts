import { describe, expect, it } from "vitest";
import { assertValidIssuer } from "../src/issuer.js";

describe("assertValidIssuer", () => {
  it("accepts an issuer with no trailing slash", () => {
    expect(() => assertValidIssuer("https://auth.brain.fi")).not.toThrow();
  });

  it("rejects a trailing slash, since it doubles the well-known path (jwks_uri, authorization_endpoint)", () => {
    expect(() => assertValidIssuer("https://auth.brain.fi/")).toThrow(/trailing slash/);
  });

  it("error message names the offending value and the fix", () => {
    expect(() => assertValidIssuer("https://auth.brain.fi/")).toThrow(
      /"https:\/\/auth\.brain\.fi\/".*"https:\/\/auth\.brain\.fi"/s,
    );
  });
});
