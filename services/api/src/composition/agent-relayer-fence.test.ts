import { describe, expect, test } from "vitest";
import { assertAgentRelayerFences } from "./agent-relayer-fence.js";

describe("assertAgentRelayerFences", () => {
  test("silent when mode=off regardless of what else is missing", () => {
    expect(() =>
      assertAgentRelayerFences({
        nodeEnv: "production",
        mode: "off",
        privateKeyConfigured: false,
        rpcUrlConfigured: false,
        registryAddressConfigured: false,
      }),
    ).not.toThrow();
  });

  test("dev mode: custodial with everything configured passes", () => {
    expect(() =>
      assertAgentRelayerFences({
        nodeEnv: "development",
        mode: "custodial",
        privateKeyConfigured: true,
        rpcUrlConfigured: true,
        registryAddressConfigured: true,
      }),
    ).not.toThrow();
  });

  test("dev mode: custodial with a missing signer key does NOT throw (only production is fenced)", () => {
    expect(() =>
      assertAgentRelayerFences({
        nodeEnv: "development",
        mode: "custodial",
        privateKeyConfigured: false,
        rpcUrlConfigured: true,
        registryAddressConfigured: true,
      }),
    ).not.toThrow();
  });

  test("production: custodial with everything configured passes", () => {
    expect(() =>
      assertAgentRelayerFences({
        nodeEnv: "production",
        mode: "custodial",
        privateKeyConfigured: true,
        rpcUrlConfigured: true,
        registryAddressConfigured: true,
      }),
    ).not.toThrow();
  });

  test("production: custodial with a missing signer key throws", () => {
    expect(() =>
      assertAgentRelayerFences({
        nodeEnv: "production",
        mode: "custodial",
        privateKeyConfigured: false,
        rpcUrlConfigured: true,
        registryAddressConfigured: true,
      }),
    ).toThrow(/BRAIN_AGENT_RELAYER_PRIVATE_KEY/);
  });

  test("production: custodial with a missing RPC URL throws", () => {
    expect(() =>
      assertAgentRelayerFences({
        nodeEnv: "production",
        mode: "custodial",
        privateKeyConfigured: true,
        rpcUrlConfigured: false,
        registryAddressConfigured: true,
      }),
    ).toThrow(/BASE_RPC_URL/);
  });

  test("production: custodial with a missing registry address throws", () => {
    expect(() =>
      assertAgentRelayerFences({
        nodeEnv: "production",
        mode: "custodial",
        privateKeyConfigured: true,
        rpcUrlConfigured: true,
        registryAddressConfigured: false,
      }),
    ).toThrow(/MCP_AGENT_REGISTRY_ADDRESS/);
  });

  test("undefined nodeEnv (boot-time race) is treated as not-production", () => {
    expect(() =>
      assertAgentRelayerFences({
        nodeEnv: undefined,
        mode: "custodial",
        privateKeyConfigured: false,
        rpcUrlConfigured: false,
        registryAddressConfigured: false,
      }),
    ).not.toThrow();
  });
});
