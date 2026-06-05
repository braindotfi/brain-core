import { describe, expect, test } from "vitest";
import { assertDemoProvisionFences } from "./demo-provision-fence.js";

/**
 * Boot-fence coverage for /v1/demo/provision-run (batch 10 C-1).
 *
 * The fence enforces two invariants. The matrix below pins both:
 *
 *   A. provisionEnabled=true requires a non-empty BRAIN_DEMO_PROVISION_SECRET
 *      in EVERY env (dev, staging, production). Without the header secret the
 *      route would mint scoped tokens to any caller that reaches it.
 *
 *   B. provisionEnabled=true in NODE_ENV=production additionally requires
 *      BRAIN_DEMO_PROVISION_TESTNET_ATTESTED="true". Mirrors the
 *      BRAIN_ESCROW_AUDIT_APPROVED gate: operators must explicitly attest
 *      that this stack is the right kind of production (testnet, sandbox
 *      rails) before the provision endpoint becomes reachable on prod.
 */
describe("assertDemoProvisionFences", () => {
  test("silent when provisioning is disabled (the default)", () => {
    // No secret, no attestation, but the route never registers, so nothing
    // to fence. Most operators run here.
    expect(() =>
      assertDemoProvisionFences({
        nodeEnv: "production",
        provisionEnabled: false,
        provisionSecret: undefined,
        testnetAttested: "false",
      }),
    ).not.toThrow();
  });

  test("dev mode: enabled + secret set + no attestation → passes", () => {
    // Local laptops. NODE_ENV !== production, so the testnet-attest gate
    // does not apply. The header secret is still mandatory because anyone
    // on localhost could otherwise hit the route from a browser tab.
    expect(() =>
      assertDemoProvisionFences({
        nodeEnv: "development",
        provisionEnabled: true,
        provisionSecret: "dev-secret",
        testnetAttested: "false",
      }),
    ).not.toThrow();
  });

  test("dev mode: enabled but no secret → throws (header secret is non-negotiable)", () => {
    expect(() =>
      assertDemoProvisionFences({
        nodeEnv: "development",
        provisionEnabled: true,
        provisionSecret: undefined,
        testnetAttested: "false",
      }),
    ).toThrow(/BRAIN_DEMO_PROVISION_SECRET is required/);
  });

  test("dev mode: enabled but empty-string secret → throws", () => {
    // Belt and suspenders. Zod's optionalNonEmptyString rejects "" but
    // some boot wirings may forward an empty literal, so the fence treats
    // length 0 as missing.
    expect(() =>
      assertDemoProvisionFences({
        nodeEnv: "development",
        provisionEnabled: true,
        provisionSecret: "",
        testnetAttested: "false",
      }),
    ).toThrow(/BRAIN_DEMO_PROVISION_SECRET is required/);
  });

  test("production: enabled + secret + attestation=true → passes (testnet prod)", () => {
    // The intended "yes I am running this on the public testnet stack" path.
    expect(() =>
      assertDemoProvisionFences({
        nodeEnv: "production",
        provisionEnabled: true,
        provisionSecret: "prod-secret",
        testnetAttested: "true",
      }),
    ).not.toThrow();
  });

  test("production: enabled + secret + attestation=false → throws (footgun)", () => {
    // The dangerous case. Operator turned the flag on in prod without the
    // explicit testnet attestation. The fence stops the boot so the
    // orchestrator surfaces it instead of an unauthenticated mint path
    // going live.
    expect(() =>
      assertDemoProvisionFences({
        nodeEnv: "production",
        provisionEnabled: true,
        provisionSecret: "prod-secret",
        testnetAttested: "false",
      }),
    ).toThrow(/BRAIN_DEMO_PROVISION_TESTNET_ATTESTED/);
  });

  test("production: enabled with no secret → throws on the secret check FIRST", () => {
    // Ordering matters: the secret check runs before the attestation check,
    // so an operator with both env vars unset sees the more actionable error
    // first (configure the header secret).
    expect(() =>
      assertDemoProvisionFences({
        nodeEnv: "production",
        provisionEnabled: true,
        provisionSecret: undefined,
        testnetAttested: "false",
      }),
    ).toThrow(/BRAIN_DEMO_PROVISION_SECRET is required/);
  });

  test("undefined nodeEnv (boot-time race) is treated as not-production", () => {
    // Process env reads can briefly return undefined during cold boot in
    // some Node runners. The fence must default to the safer behaviour:
    // require the secret, do not require attestation.
    expect(() =>
      assertDemoProvisionFences({
        nodeEnv: undefined,
        provisionEnabled: true,
        provisionSecret: "secret",
        testnetAttested: "false",
      }),
    ).not.toThrow();
  });
});
