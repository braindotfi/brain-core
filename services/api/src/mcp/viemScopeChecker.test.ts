import { describe, it, expect, vi } from "vitest";
import * as viem from "viem";

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof viem>();
  return { ...actual, createPublicClient: vi.fn() };
});

import { createViemScopeChecker } from "./viemScopeChecker.js";

function setupReadContract(result: unknown) {
  const readContract = vi.fn().mockResolvedValue(result);
  vi.mocked(viem.createPublicClient).mockReturnValue({
    readContract,
  } as unknown as ReturnType<typeof viem.createPublicClient>);
  return readContract;
}

const opts = {
  contractAddress: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  rpcUrl: "https://sepolia.base.org",
};

describe("createViemScopeChecker", () => {
  it("returns lowercase hex scope hash for a registered, non-revoked agent", async () => {
    const scopeHashHex = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    setupReadContract({
      agentId: "0x" + "00".repeat(32),
      agentAddress: "0x0000000000000000000000000000000000000001",
      tenantId: "0x" + "00".repeat(32),
      scopeHash: scopeHashHex,
      registeredAt: 1000n,
      revokedAt: 0n,
    });

    const checker = createViemScopeChecker(opts);
    const result = await checker.getOnchainScopeHash("agent_abc");

    expect(result).toBe("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");
  });

  it("returns null for a revoked agent", async () => {
    setupReadContract({
      agentId: "0x" + "00".repeat(32),
      agentAddress: "0x0000000000000000000000000000000000000001",
      tenantId: "0x" + "00".repeat(32),
      scopeHash: "0x" + "aa".repeat(32),
      registeredAt: 1000n,
      revokedAt: 2000n,
    });

    const checker = createViemScopeChecker(opts);
    expect(await checker.getOnchainScopeHash("agent_abc")).toBeNull();
  });

  it("returns null when the agent is not registered (registeredAt = 0)", async () => {
    setupReadContract({
      agentId: "0x" + "00".repeat(32),
      agentAddress: "0x0000000000000000000000000000000000000000",
      tenantId: "0x" + "00".repeat(32),
      scopeHash: "0x" + "00".repeat(32),
      registeredAt: 0n,
      revokedAt: 0n,
    });

    const checker = createViemScopeChecker(opts);
    expect(await checker.getOnchainScopeHash("agent_unknown")).toBeNull();
  });
});
