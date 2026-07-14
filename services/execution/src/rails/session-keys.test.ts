import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_KEY_TTL_SECONDS, derivePerTaskSessionKey } from "./session-keys.js";

describe("derivePerTaskSessionKey (3.3)", () => {
  it("bounds the key to the exact counterparty, amount, and a ~10m window", () => {
    const key = derivePerTaskSessionKey({
      holder: "0xWorker",
      targetAddress: "0xCounterparty",
      capToken: "0xToken",
      amountRawUnits: 1_000_000n,
      policyVersion: "0xpol",
      allowedSelectors: ["0xa9059cbb"],
      nowSeconds: 1_000,
    });
    expect(key.allowedTargets).toEqual(["0xCounterparty"]); // exactly this target
    expect(key.allowedSelectors).toEqual(["0xa9059cbb"]);
    expect(key.capToken).toBe("0xToken");
    expect(key.maxPerTx).toBe("1000000");
    expect(key.maxPerPeriod).toBe("1000000"); // per-tx == per-period: at most one transfer
    expect(key.validAfter).toBe("1000");
    expect(key.validUntil).toBe(String(1_000 + DEFAULT_TASK_KEY_TTL_SECONDS));
    expect(key.periodSeconds).toBe(String(DEFAULT_TASK_KEY_TTL_SECONDS));
    expect(key.policyVersion).toBe("0xpol");
  });

  it("accepts a string amount and a custom ttl", () => {
    const key = derivePerTaskSessionKey({
      holder: "0xW",
      targetAddress: "0xC",
      capToken: "0x0000000000000000000000000000000000000000",
      amountRawUnits: "250",
      policyVersion: "0xp",
      allowedSelectors: ["0x00000000"],
      nowSeconds: 0,
      ttlSeconds: 60,
    });
    expect(key.capToken).toBe("0x0000000000000000000000000000000000000000");
    expect(key.maxPerTx).toBe("250");
    expect(key.validUntil).toBe("60");
    expect(key.periodSeconds).toBe("60");
  });
});
