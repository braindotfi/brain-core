import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Viem from "viem";

// Mock viem's createPublicClient so the seam can be tested without a real RPC.
const readContractMock = vi.fn();
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof Viem>();
  return { ...actual, createPublicClient: () => ({ readContract: readContractMock }) };
});

const { makeBaseGetErc20Decimals, assertSettlementTokenIsSixDecimals } = await import(
  "./settlement-decimals-gate.js"
);

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe("makeBaseGetErc20Decimals", () => {
  beforeEach(() => readContractMock.mockReset());

  it("reads decimals() via readContract", async () => {
    readContractMock.mockResolvedValueOnce(6);
    const getDecimals = makeBaseGetErc20Decimals("https://rpc.example", 8453);
    expect(await getDecimals(USDC)).toBe(6);
    expect(readContractMock).toHaveBeenCalledWith(
      expect.objectContaining({ address: USDC, functionName: "decimals" }),
    );
  });
});

describe("assertSettlementTokenIsSixDecimals", () => {
  it("is silent when no token is configured (nothing to check)", async () => {
    await expect(
      assertSettlementTokenIsSixDecimals({
        tokenAddress: undefined,
        getDecimals: async () => 18,
      }),
    ).resolves.toBeUndefined();
  });

  it("is silent when the configured token reports 6 decimals", async () => {
    await expect(
      assertSettlementTokenIsSixDecimals({ tokenAddress: USDC, getDecimals: async () => 6 }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the configured token reports 18 decimals (the T8 risk)", async () => {
    // This is the exact mismatch that inflates check 6.6's `remaining` by
    // 10^12 while the rail releases 10^-12 of the intent.
    await expect(
      assertSettlementTokenIsSixDecimals({ tokenAddress: USDC, getDecimals: async () => 18 }),
    ).rejects.toThrow(/decimals\(\)=18/);
  });

  it("fails closed for any other non-6 decimals value, not only 18", async () => {
    await expect(
      assertSettlementTokenIsSixDecimals({ tokenAddress: USDC, getDecimals: async () => 0 }),
    ).rejects.toThrow(/decimals\(\)=0/);
  });
});
