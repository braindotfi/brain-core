import { describe, expect, it, vi } from "vitest";
import {
  CoinbaseCdpApiKeyTokenProvider,
  CoinbaseX402Adapter,
  CoinbaseX402OperationGate,
  X402_CDP_LOGICAL_OPERATIONS_PER_SECOND,
} from "./coinbase-x402-adapter.js";
import {
  X402_BASE_SEPOLIA_NETWORK,
  X402_BASE_SEPOLIA_USDC,
  type X402V2ExactRequirements,
} from "./x402-seller-protocol.js";

const requirements: X402V2ExactRequirements = {
  x402Version: 2,
  scheme: "exact",
  network: X402_BASE_SEPOLIA_NETWORK,
  asset: X402_BASE_SEPOLIA_USDC,
  amount: "10000",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

describe("Coinbase x402 adapter", () => {
  it("generates a two-minute request-bound bearer token", async () => {
    const generate = vi.fn(async () => "signed-token");
    const provider = new CoinbaseCdpApiKeyTokenProvider(
      { apiKeyId: "organizations/org/apiKeys/key", apiKeySecret: "redacted" },
      generate as never,
    );
    await expect(
      provider.getAuthorizationHeader({
        method: "GET",
        path: "/platform/v2/x402/supported",
      }),
    ).resolves.toBe("Bearer signed-token");
    expect(generate).toHaveBeenCalledWith({
      apiKeyId: "organizations/org/apiKeys/key",
      apiKeySecret: "redacted",
      requestMethod: "GET",
      requestHost: "api.cdp.coinbase.com",
      requestPath: "/platform/v2/x402/supported",
      expiresIn: 120,
    });
  });

  it("captures authenticated pinned support evidence without retaining a token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer redacted" });
      return new Response(
        JSON.stringify({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: X402_BASE_SEPOLIA_NETWORK,
            },
          ],
        }),
        { status: 200 },
      );
    });
    const adapter = new CoinbaseX402Adapter({
      tokenProvider: { getAuthorizationHeader: async () => "Bearer redacted" },
      fetchImpl,
      now: () => Date.parse("2026-09-16T00:00:00Z"),
    });
    const witness = await adapter.captureSupportedWitness();
    expect(witness).toMatchObject({
      supported: true,
      protocolVersion: 2,
      scheme: "exact",
      network: X402_BASE_SEPOLIA_NETWORK,
      asset: X402_BASE_SEPOLIA_USDC,
    });
    expect(witness.responseDigestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires v2, exact, and Base Sepolia on the same supported kind", async () => {
    const adapter = new CoinbaseX402Adapter({
      tokenProvider: {
        getAuthorizationHeader: async () => "Bearer redacted",
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            kinds: [
              { x402Version: 2, scheme: "exact", network: "eip155:8453" },
              { x402Version: 1, scheme: "exact", network: "base-sepolia" },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(adapter.captureSupportedWitness()).rejects.toThrow(/does not advertise/);
  });

  it("uses the v2 verify and settle bodies and returns normalized results", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/verify")) {
        return new Response(JSON.stringify({ isValid: true, payer: "0xpayer" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          success: true,
          payer: "0xpayer",
          transaction: `0x${"a".repeat(64)}`,
          network: X402_BASE_SEPOLIA_NETWORK,
          errorReason: null,
        }),
        { status: 200 },
      );
    });
    const adapter = new CoinbaseX402Adapter({
      tokenProvider: { getAuthorizationHeader: async () => "Bearer redacted" },
      fetchImpl,
    });
    expect(
      await adapter.verify({
        paymentPayload: { token: "redacted" },
        paymentRequirements: requirements,
      }),
    ).toEqual({
      valid: true,
      payer: "0xpayer",
      reason: null,
    });
    expect(
      await adapter.settle({ paymentPayload: {}, paymentRequirements: requirements }),
    ).toMatchObject({
      success: true,
      network: X402_BASE_SEPOLIA_NETWORK,
    });
    const posted = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(posted.x402Version).toBe(2);
  });

  it("admits no more than 20 logical operations in one rolling second", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const gate = new CoinbaseX402OperationGate(
      () => now,
      async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    );
    for (let index = 0; index < X402_CDP_LOGICAL_OPERATIONS_PER_SECOND + 1; index += 1) {
      await gate.enter();
    }
    expect(sleeps).toEqual([1_000]);
  });

  it("redacts response bodies from errors", async () => {
    const adapter = new CoinbaseX402Adapter({
      tokenProvider: { getAuthorizationHeader: async () => "Bearer redacted" },
      fetchImpl: async () => new Response('{"secret":"must-not-appear"}', { status: 401 }),
    });
    await expect(adapter.captureSupportedWitness()).rejects.toThrow(
      "Coinbase CDP /supported failed with status 401",
    );
  });
});
