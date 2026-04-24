import { describe, expect, it } from "vitest";
import { buildTypedData, computeDigest, digestHex, tenantIdToBytes32 } from "./signing.js";

describe("tenantIdToBytes32", () => {
  it("is deterministic and 32 bytes hex", () => {
    const a = tenantIdToBytes32("tnt_01HQ7K3ABCDEFGHJKMNPQRSTV");
    const b = tenantIdToBytes32("tnt_01HQ7K3ABCDEFGHJKMNPQRSTV");
    expect(a).toBe(b);
    expect(a.startsWith("0x")).toBe(true);
    expect(a.length).toBe(66);
  });
  it("differs for different ids", () => {
    expect(tenantIdToBytes32("tnt_a")).not.toBe(tenantIdToBytes32("tnt_b"));
  });
});

describe("buildTypedData", () => {
  it("returns the EIP-712 skeleton matching BrainPolicyRegistry.registerPolicy", () => {
    const t = buildTypedData({
      tenantId: "tnt_TEST",
      version: 3,
      policyHashHex: "a".repeat(64),
      chainId: 8453, // Base mainnet
      verifyingContract: "0x0000000000000000000000000000000000000001",
    });
    expect(t.primaryType).toBe("PolicyRegistration");
    expect(t.domain.name).toBe("Brain Policy");
    expect(t.domain.chainId).toBe(8453);
    expect(t.message.version).toBe(3n);
    expect(t.message.policyHash.startsWith("0x")).toBe(true);
  });
});

describe("computeDigest / digestHex", () => {
  it("is deterministic across identical inputs", () => {
    const t = buildTypedData({
      tenantId: "tnt_X",
      version: 1,
      policyHashHex: "b".repeat(64),
      chainId: 84532,
      verifyingContract: "0x0000000000000000000000000000000000000002",
    });
    const a = digestHex(t);
    const b = digestHex(t);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(computeDigest(t)).toBeInstanceOf(Uint8Array);
  });
  it("changes when the policy hash changes", () => {
    const base = {
      tenantId: "tnt_X",
      version: 1,
      chainId: 84532,
      verifyingContract: "0x0000000000000000000000000000000000000002" as const,
    };
    const a = digestHex(buildTypedData({ ...base, policyHashHex: "c".repeat(64) }));
    const b = digestHex(buildTypedData({ ...base, policyHashHex: "d".repeat(64) }));
    expect(a).not.toBe(b);
  });
});
