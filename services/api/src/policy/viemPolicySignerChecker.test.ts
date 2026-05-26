/**
 * Unit tests for createViemPolicySignerChecker (fix/main-green). viem +
 * @brain/policy are mocked; asserts the on-chain read result is returned and
 * that any RPC error fails closed to `false`.
 */

import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ readContract: vi.fn() }));

vi.mock("viem", () => ({
  createPublicClient: vi.fn(() => ({ readContract: m.readContract })),
  http: vi.fn(() => ({})),
}));
vi.mock("viem/chains", () => ({ baseSepolia: { id: 84_532 } }));
vi.mock("@brain/policy", () => ({ tenantIdToBytes32: vi.fn(() => ("0x" + "00".repeat(32)) as string) }));

import { createViemPolicySignerChecker } from "./viemPolicySignerChecker.js";

const OPTS = { contractAddress: ("0x" + "ab".repeat(20)) as `0x${string}`, rpcUrl: "http://rpc" };

describe("createViemPolicySignerChecker", () => {
  it("returns the on-chain isTenantSigner result", async () => {
    m.readContract.mockResolvedValue(true);
    const check = createViemPolicySignerChecker(OPTS);
    expect(await check("tnt_x", "0xADDR")).toBe(true);
    expect(m.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "isTenantSigner" }),
    );
  });

  it("returns false when the registry says not-a-signer", async () => {
    m.readContract.mockResolvedValue(false);
    expect(await createViemPolicySignerChecker(OPTS)("tnt_x", "0xADDR")).toBe(false);
  });

  it("fails closed (false) when the RPC read throws", async () => {
    m.readContract.mockRejectedValue(new Error("rpc down"));
    expect(await createViemPolicySignerChecker(OPTS)("tnt_x", "0xADDR")).toBe(false);
  });
});
