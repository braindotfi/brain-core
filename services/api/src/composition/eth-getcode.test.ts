import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Viem from "viem";

// Mock viem's createPublicClient so the seam can be tested without a real RPC.
// We keep the rest of viem real (http, base, baseSepolia) so makeBaseGetCode's
// chain selection still runs against the genuine chain objects.
const getCodeMock = vi.fn();
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof Viem>();
  return { ...actual, createPublicClient: () => ({ getCode: getCodeMock }) };
});

const { makeBaseGetCode } = await import("./eth-getcode.js");

describe("makeBaseGetCode", () => {
  beforeEach(() => getCodeMock.mockReset());

  it("returns the deployed code hex from eth_getCode (mainnet)", async () => {
    getCodeMock.mockResolvedValueOnce("0xdeadbeef");
    const getCode = makeBaseGetCode("https://rpc.example", 8453);
    expect(await getCode("0x000000000000000000000000000000000000dEaD")).toBe("0xdeadbeef");
    expect(getCodeMock).toHaveBeenCalledWith({
      address: "0x000000000000000000000000000000000000dEaD",
    });
  });

  it("returns 0x (fail-closed 'no contract') when eth_getCode yields undefined", async () => {
    getCodeMock.mockResolvedValueOnce(undefined);
    const getCode = makeBaseGetCode("https://rpc.example", 84532);
    expect(await getCode("0x000000000000000000000000000000000000dEaD")).toBe("0x");
  });
});
