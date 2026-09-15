import { describe, expect, it, vi } from "vitest";
import {
  X402_DESTINATION_CHANGE_CONFIRMATION,
  X402DestinationChangeService,
  x402DestinationChangeManifestDigest,
} from "./x402-destination-change-service.js";

const address = "0x52908400098527886E0F7030069857D2E4169EE7";
const approvedSha = "a".repeat(40);
const testTransferTxHash = `0x${"b".repeat(64)}`;

function input(environment: "sandbox" | "live" = "sandbox") {
  return {
    environment,
    address,
    approvedSha,
    requestedAt: new Date("2026-09-16T00:00:00Z"),
    treasury: { actor: "treasury-reviewer", approvedAt: new Date("2026-09-16T00:01:00Z") },
    security: { actor: "security-reviewer", approvedAt: new Date("2026-09-16T00:02:00Z") },
    testTransferTxHash,
    confirmation: X402_DESTINATION_CHANGE_CONFIRMATION,
    manifestDigest: x402DestinationChangeManifestDigest({
      environment,
      address,
      approvedSha,
      testTransferTxHash,
    }),
  };
}

describe("x402 destination change service", () => {
  it("persists a verified two-human sandbox approval", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const verify = vi.fn(async () => true);
    const service = new X402DestinationChangeService({ query } as never, { verify });
    const result = await service.authorize(input());

    expect(verify).toHaveBeenCalledWith({
      environment: "sandbox",
      destination: address,
      transactionHash: testTransferTxHash,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(result.effectiveAt.toISOString()).toBe("2026-09-16T00:02:00.000Z");
  });

  it("applies the non-bypassable 24-hour live delay", async () => {
    const service = new X402DestinationChangeService(
      { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) } as never,
      { verify: async () => true },
    );
    const result = await service.authorize(input("live"));
    expect(result.effectiveAt.toISOString()).toBe("2026-09-17T00:02:00.000Z");
  });

  it("rejects same-human approval, altered manifests, and unconfirmed transfers", async () => {
    const service = new X402DestinationChangeService({ query: vi.fn() } as never, {
      verify: async () => false,
    });
    await expect(
      service.authorize({
        ...input(),
        security: { actor: "treasury-reviewer", approvedAt: new Date() },
      }),
    ).rejects.toThrow(/two different human/);
    await expect(service.authorize({ ...input(), manifestDigest: "c".repeat(64) })).rejects.toThrow(
      /manifest digest/,
    );
    await expect(service.authorize(input())).rejects.toThrow(/test transfer is not confirmed/);
  });
});
