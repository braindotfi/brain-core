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
      behaviorHash: "0x" + "ee".repeat(32),
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
      behaviorHash: "0x" + "ee".repeat(32),
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
      behaviorHash: "0x" + "00".repeat(32),
      registeredAt: 0n,
      revokedAt: 0n,
    });

    const checker = createViemScopeChecker(opts);
    expect(await checker.getOnchainScopeHash("agent_unknown")).toBeNull();
  });

  // R-32 regression: the checker's ABI must mirror the on-chain 7-field
  // AgentRegistration tuple exactly. This test encodes a result the way the
  // contract actually would (behaviorHash BETWEEN scopeHash and registeredAt)
  // and lets the checker's own ABI decode it positionally via real viem.
  // If behaviorHash is dropped from the ABI, registeredAt/revokedAt land on the
  // wrong slots and the checker returns null for a valid agent — caught here.
  it("decodes the on-chain 7-field tuple without field shift (R-32 regression)", async () => {
    const scopeHashHex: `0x${string}` = `0x${"cd".repeat(32)}`;
    const onchainAbi = [
      {
        name: "getAgent",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "agentId", type: "bytes32" }],
        outputs: [
          {
            name: "",
            type: "tuple",
            components: [
              { name: "agentId", type: "bytes32" },
              { name: "agentAddress", type: "address" },
              { name: "tenantId", type: "bytes32" },
              { name: "scopeHash", type: "bytes32" },
              { name: "behaviorHash", type: "bytes32" },
              { name: "registeredAt", type: "uint256" },
              { name: "revokedAt", type: "uint256" },
            ],
          },
        ],
      },
    ] as const;

    const encoded = viem.encodeFunctionResult({
      abi: onchainAbi,
      functionName: "getAgent",
      result: {
        agentId: `0x${"00".repeat(32)}`,
        agentAddress: "0x0000000000000000000000000000000000000001",
        tenantId: `0x${"00".repeat(32)}`,
        scopeHash: scopeHashHex,
        // Non-zero behaviorHash: if mis-decoded as registeredAt the guard would
        // see a non-zero registeredAt but a non-zero revokedAt and return null.
        behaviorHash: `0x${"ef".repeat(32)}`,
        registeredAt: 1000n,
        revokedAt: 0n,
      },
    });

    // Decode with whatever ABI the checker passes — proving its field order.
    const readContract = vi
      .fn()
      .mockImplementation(({ abi, functionName }: { abi: viem.Abi; functionName: string }) =>
        viem.decodeFunctionResult({ abi, functionName, data: encoded }),
      );
    vi.mocked(viem.createPublicClient).mockReturnValue({
      readContract,
    } as unknown as ReturnType<typeof viem.createPublicClient>);

    const checker = createViemScopeChecker(opts);
    expect(await checker.getOnchainScopeHash("agent_abc")).toBe(scopeHashHex.slice(2));
  });
});
