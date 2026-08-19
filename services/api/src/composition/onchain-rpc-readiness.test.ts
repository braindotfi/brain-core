import { MockMetrics } from "@brain/shared";
import { describe, expect, it, vi } from "vitest";
import { OnchainRpcReadiness, isTransientRpcUnavailable } from "./onchain-rpc-readiness.js";

const metrics = new MockMetrics();
const log = { info: vi.fn(), warn: vi.fn() };

describe("OnchainRpcReadiness", () => {
  it("uses the next endpoint after a transient provider failure", async () => {
    const validate = vi.fn(async (endpoint: string) => {
      if (endpoint === "https://primary.example") {
        throw new Error("RpcRequestError: no backend is currently healthy to serve traffic");
      }
    });
    const readiness = new OnchainRpcReadiness({
      endpoints: ["https://primary.example", "https://fallback.example"],
      validate,
      metrics,
      log,
    });

    await expect(readiness.validateNow()).resolves.toBe(true);
    expect(readiness.snapshot()).toMatchObject({
      status: "ready",
      endpoint: "https://fallback.example",
    });
  });

  it("keeps a confirmed chain safety failure fatal", async () => {
    const readiness = new OnchainRpcReadiness({
      endpoints: ["https://primary.example"],
      validate: async () => {
        throw new Error("BASE_RPC_URL reports chainId=1 but BRAIN_BASE_CHAIN_ID is 84532");
      },
      metrics,
      log,
    });

    await expect(readiness.validateNow()).rejects.toThrow("chainId=1");
  });

  it("reports a provider outage as degraded", async () => {
    const readiness = new OnchainRpcReadiness({
      endpoints: ["https://primary.example"],
      validate: async () => {
        throw new Error("fetch failed: ETIMEDOUT");
      },
      metrics,
      log,
    });

    await expect(readiness.validateNow()).resolves.toBe(false);
    expect(readiness.snapshot()).toMatchObject({ status: "degraded", reason: "rpc_unavailable" });
  });

  it("recognizes the Base provider outage observed in staging", () => {
    expect(
      isTransientRpcUnavailable(new Error("no backend is currently healthy to serve traffic")),
    ).toBe(true);
    expect(
      isTransientRpcUnavailable(new Error("BrainAuditAnchor deployed code is missing anchorBatch")),
    ).toBe(false);
  });
});
