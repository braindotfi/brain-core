import { describe, expect, test } from "vitest";
import { assertServiceTokenFences } from "./service-token-fence.js";

/**
 * Boot-fence coverage for POST /v1/auth/service-token.
 *
 * The fence enforces two invariants (mirrors the demo-provision fence):
 *
 *   A. serviceTokenEnabled=true requires a non-empty BRAIN_SERVICE_TOKEN_SECRET
 *      in EVERY env. Without the header secret the route would mint scoped
 *      tokens to any caller that reaches it.
 *
 *   B. serviceTokenEnabled=true in NODE_ENV=production additionally requires
 *      BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED="true". Operators must explicitly
 *      attest that this stack is the right kind of production (testnet, sandbox
 *      rails) before the propose/approve-capable mint becomes reachable on prod.
 */
describe("assertServiceTokenFences", () => {
  test("silent when the route is disabled (the default)", () => {
    expect(() =>
      assertServiceTokenFences({
        nodeEnv: "production",
        serviceTokenEnabled: false,
        serviceTokenSecret: undefined,
        testnetAttested: "false",
      }),
    ).not.toThrow();
  });

  test("dev mode: enabled + secret set + no attestation → passes", () => {
    expect(() =>
      assertServiceTokenFences({
        nodeEnv: "development",
        serviceTokenEnabled: true,
        serviceTokenSecret: "dev-secret",
        testnetAttested: "false",
      }),
    ).not.toThrow();
  });

  test("dev mode: enabled but no secret → throws (header secret is non-negotiable)", () => {
    expect(() =>
      assertServiceTokenFences({
        nodeEnv: "development",
        serviceTokenEnabled: true,
        serviceTokenSecret: undefined,
        testnetAttested: "false",
      }),
    ).toThrow(/BRAIN_SERVICE_TOKEN_SECRET is required/);
  });

  test("dev mode: enabled but empty-string secret → throws", () => {
    expect(() =>
      assertServiceTokenFences({
        nodeEnv: "development",
        serviceTokenEnabled: true,
        serviceTokenSecret: "",
        testnetAttested: "false",
      }),
    ).toThrow(/BRAIN_SERVICE_TOKEN_SECRET is required/);
  });

  test("production: enabled + secret + attestation=true → passes (testnet prod)", () => {
    expect(() =>
      assertServiceTokenFences({
        nodeEnv: "production",
        serviceTokenEnabled: true,
        serviceTokenSecret: "prod-secret",
        testnetAttested: "true",
      }),
    ).not.toThrow();
  });

  test("production: enabled + secret + attestation=false → throws (footgun)", () => {
    expect(() =>
      assertServiceTokenFences({
        nodeEnv: "production",
        serviceTokenEnabled: true,
        serviceTokenSecret: "prod-secret",
        testnetAttested: "false",
      }),
    ).toThrow(/BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED/);
  });

  test("production: enabled with no secret → throws on the secret check FIRST", () => {
    expect(() =>
      assertServiceTokenFences({
        nodeEnv: "production",
        serviceTokenEnabled: true,
        serviceTokenSecret: undefined,
        testnetAttested: "false",
      }),
    ).toThrow(/BRAIN_SERVICE_TOKEN_SECRET is required/);
  });

  test("undefined nodeEnv (boot-time race) is treated as not-production", () => {
    expect(() =>
      assertServiceTokenFences({
        nodeEnv: undefined,
        serviceTokenEnabled: true,
        serviceTokenSecret: "secret",
        testnetAttested: "false",
      }),
    ).not.toThrow();
  });
});
