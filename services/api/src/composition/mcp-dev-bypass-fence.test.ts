import { describe, expect, test } from "vitest";
import { assertMcpDevBypassFence, isMcpDevBypassAllowed } from "./mcp-dev-bypass-fence.js";

/**
 * Boot-fence coverage for BRAIN_MCP_DEV_AUTH_BYPASS (BRAIN-97).
 *
 * The fence is an ALLOWLIST: the bypass may only be enabled when NODE_ENV is
 * "development" or "test". Every other value -- staging, production, and an
 * unexpected or missing NODE_ENV -- must refuse to boot.
 */
describe("isMcpDevBypassAllowed", () => {
  test("allows development and test", () => {
    expect(isMcpDevBypassAllowed("development")).toBe(true);
    expect(isMcpDevBypassAllowed("test")).toBe(true);
  });

  test("refuses staging, production, an unrecognized value, and undefined", () => {
    expect(isMcpDevBypassAllowed("staging")).toBe(false);
    expect(isMcpDevBypassAllowed("production")).toBe(false);
    expect(isMcpDevBypassAllowed("qa")).toBe(false);
    expect(isMcpDevBypassAllowed(undefined)).toBe(false);
  });
});

describe("assertMcpDevBypassFence", () => {
  test("silent when the bypass is disabled, in every NODE_ENV", () => {
    for (const nodeEnv of ["development", "test", "staging", "production", undefined]) {
      expect(() => assertMcpDevBypassFence({ nodeEnv, devAuthBypass: false })).not.toThrow();
    }
  });

  test("enabled + development -> passes", () => {
    expect(() =>
      assertMcpDevBypassFence({ nodeEnv: "development", devAuthBypass: true }),
    ).not.toThrow();
  });

  test("enabled + test -> passes", () => {
    expect(() => assertMcpDevBypassFence({ nodeEnv: "test", devAuthBypass: true })).not.toThrow();
  });

  test("enabled + staging -> throws (a real deployed environment with a real database)", () => {
    expect(() => assertMcpDevBypassFence({ nodeEnv: "staging", devAuthBypass: true })).toThrow(
      /development or test/,
    );
  });

  test("enabled + production -> throws", () => {
    expect(() => assertMcpDevBypassFence({ nodeEnv: "production", devAuthBypass: true })).toThrow(
      /development or test/,
    );
  });

  test("enabled + undefined NODE_ENV -> throws (fail closed, not fail open)", () => {
    // Unlike demo-provision-fence.ts (which treats an undefined boot-time
    // NODE_ENV as "not production" and lets it through), this is an
    // allowlist: anything that is not affirmatively development or test is
    // refused, including a missing value.
    expect(() => assertMcpDevBypassFence({ nodeEnv: undefined, devAuthBypass: true })).toThrow(
      /development or test/,
    );
  });
});
