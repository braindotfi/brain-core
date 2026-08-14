import { describe, it, expect, vi } from "vitest";
import * as viem from "viem";

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof viem>();
  return { ...actual, createPublicClient: vi.fn() };
});

import { createAuthOnchainScopeChecker } from "../src/onchain-scope-checker.js";
import { OnchainScopeUnavailableError } from "@brain/mcp";

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

describe("createAuthOnchainScopeChecker (services/api's viemScopeChecker.ts, partially duplicated -- see file header)", () => {
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

    const checker = createAuthOnchainScopeChecker(opts);
    expect(await checker.getOnchainScopeHash("agent_abc")).toBe(
      "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    );
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

    const checker = createAuthOnchainScopeChecker(opts);
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

    const checker = createAuthOnchainScopeChecker(opts);
    expect(await checker.getOnchainScopeHash("agent_unknown")).toBeNull();
  });

  it("throws OnchainScopeUnavailableError (fails closed, diagnosably) when the read rejects", async () => {
    // Was "fails closed to null" before the RFC 0002 Phase C fail-open fix:
    // collapsing an RPC/decode fault to null let a chain outage silently read
    // as "agent has no on-chain scope", indistinguishable from a genuinely
    // unregistered agent. Callers still fail closed overall (assertScopeHashAcceptable
    // does not catch this), only the diagnosis improved.
    const readContract = vi.fn().mockRejectedValue(new Error("boom"));
    vi.mocked(viem.createPublicClient).mockReturnValue({
      readContract,
    } as unknown as ReturnType<typeof viem.createPublicClient>);

    const checker = createAuthOnchainScopeChecker(opts);
    await expect(checker.getOnchainScopeHash("agent_abc")).rejects.toBeInstanceOf(
      OnchainScopeUnavailableError,
    );
  });
});
