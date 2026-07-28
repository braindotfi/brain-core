import { describe, expect, it } from "vitest";
import { generateSignKeyJwk } from "@brain/shared";
import { buildJwks } from "../src/jwks.js";

const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi"] as const;

describe("buildJwks", () => {
  it("serves no private key material", async () => {
    const privateJwk = await generateSignKeyJwk();
    const { jwks } = buildJwks(JSON.stringify(privateJwk));
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0]!;
    for (const member of PRIVATE_JWK_MEMBERS) {
      expect(key).not.toHaveProperty(member);
    }
  });

  it("publishes the same kid the private key carries, so tools/static-jwks and this service never disagree", async () => {
    const privateJwk = await generateSignKeyJwk();
    const { kid, jwks } = buildJwks(JSON.stringify(privateJwk));
    expect(kid).toBe(privateJwk.kid);
    expect(jwks.keys[0]?.["kid"]).toBe(privateJwk.kid);
  });
});
