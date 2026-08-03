import { describe, expect, it } from "vitest";
import { CapMode, DEFAULT_TASK_KEY_TTL_SECONDS, derivePerTaskSessionKey } from "./session-keys.js";

const TOKEN = "0x" + "11".repeat(20);
const COUNTERPARTY = "0x" + "22".repeat(20);
const ZERO = "0x0000000000000000000000000000000000000000";

describe("derivePerTaskSessionKey (3.3)", () => {
  it("bounds the key to the exact counterparty, amount, and a ~10m window", () => {
    const key = derivePerTaskSessionKey({
      holder: "0xWorker",
      recipientAddress: COUNTERPARTY,
      capToken: TOKEN,
      amountRawUnits: 1_000_000n,
      policyVersion: "0xpol",
      allowedSelectors: ["0xa9059cbb"],
      nowSeconds: 1_000,
    });

    expect(key.capMode).toBe(CapMode.ERC20);
    // ERC20 mode meters the token, so the TARGET must be the token contract.
    expect(key.allowedTargets).toEqual([TOKEN]);
    // The counterparty binding lives here, because in ERC20 mode the payee is a
    // calldata argument the target allowlist cannot reach.
    expect(key.allowedRecipients).toEqual([COUNTERPARTY]);
    expect(key.allowedSelectors).toEqual(["0xa9059cbb"]);
    expect(key.capToken).toBe(TOKEN);
    expect(key.maxPerTx).toBe("1000000");
    expect(key.maxPerPeriod).toBe("1000000"); // per-tx == per-period: at most one transfer
    expect(key.validAfter).toBe("1000");
    expect(key.validUntil).toBe(String(1_000 + DEFAULT_TASK_KEY_TTL_SECONDS));
    expect(key.periodSeconds).toBe(String(DEFAULT_TASK_KEY_TTL_SECONDS));
    expect(key.policyVersion).toBe("0xpol");
  });

  /**
   * The spend window anchors to validAfter, so a per-task key whose lifetime
   * equals one period has exactly ONE accounting window. With epoch-aligned
   * windows a boundary almost always fell inside the lifetime, letting the key
   * spend its full cap twice.
   */
  it("makes the accounting window start at issuance and span the whole lifetime", () => {
    const key = derivePerTaskSessionKey({
      holder: "0xW",
      recipientAddress: COUNTERPARTY,
      capToken: TOKEN,
      amountRawUnits: 1n,
      policyVersion: "0xp",
      nowSeconds: 1_000_233, // deliberately not period-aligned
    });
    expect(key.validAfter).toBe("1000233");
    expect(Number(key.periodSeconds)).toBe(Number(key.validUntil) - Number(key.validAfter));
  });

  it("defaults to transfer + transferFrom, never approve", () => {
    const key = derivePerTaskSessionKey({
      holder: "0xW",
      recipientAddress: COUNTERPARTY,
      capToken: TOKEN,
      amountRawUnits: 1n,
      policyVersion: "0xp",
      nowSeconds: 0,
    });
    expect(key.allowedSelectors).toEqual(["0xa9059cbb", "0x23b872dd"]);
    // approve(address,uint256) outlives the accounting window, so a per-task
    // key must never carry it.
    expect(key.allowedSelectors).not.toContain("0x095ea7b3");
  });

  it("uses NATIVE mode for a zero capToken, with no calldata scope", () => {
    const key = derivePerTaskSessionKey({
      holder: "0xW",
      recipientAddress: COUNTERPARTY,
      capToken: ZERO,
      amountRawUnits: "250",
      policyVersion: "0xp",
      nowSeconds: 0,
      ttlSeconds: 60,
    });

    expect(key.capMode).toBe(CapMode.NATIVE);
    expect(key.capToken).toBe(ZERO);
    // A plain value transfer goes straight to the recipient and carries no
    // calldata, so the selector and recipient allowlists must be empty.
    expect(key.allowedTargets).toEqual([COUNTERPARTY]);
    expect(key.allowedSelectors).toEqual([]);
    expect(key.allowedRecipients).toEqual([]);
    expect(key.maxPerTx).toBe("250");
    expect(key.validUntil).toBe("60");
    expect(key.periodSeconds).toBe("60");
  });

  it("accepts a string amount", () => {
    const key = derivePerTaskSessionKey({
      holder: "0xW",
      recipientAddress: COUNTERPARTY,
      capToken: TOKEN,
      amountRawUnits: "250",
      policyVersion: "0xp",
      nowSeconds: 0,
    });
    expect(key.maxPerTx).toBe("250");
    expect(key.maxPerPeriod).toBe("250");
  });
});
