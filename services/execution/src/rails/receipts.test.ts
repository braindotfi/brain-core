import { describe, expect, it } from "vitest";
import { railKeyForActionType, validateRailReceipt } from "./receipts.js";

describe("railKeyForActionType", () => {
  it("maps action types to receipt rail keys", () => {
    expect(railKeyForActionType("ach_outbound")).toBe("ach");
    expect(railKeyForActionType("ach_inbound")).toBe("ach");
    expect(railKeyForActionType("wire")).toBe("wire");
    expect(railKeyForActionType("erp_writeback")).toBe("erp");
    expect(railKeyForActionType("onchain_transfer")).toBe("onchain");
    expect(railKeyForActionType("card_payment")).toBeNull();
  });
});

describe("validateRailReceipt", () => {
  it("accepts a well-formed ach receipt and rejects a missing trace", () => {
    expect(validateRailReceipt("ach", { rail: "ach", ach_trace: "T1" }).ok).toBe(true);
    const bad = validateRailReceipt("ach", { rail: "ach" });
    expect(bad.ok).toBe(false);
    expect(bad.missing).toContain("ach_trace");
  });

  it("requires omad + imad for wire", () => {
    expect(validateRailReceipt("wire", { omad: "O", imad: "I" }).ok).toBe(true);
    expect(validateRailReceipt("wire", { omad: "O" }).ok).toBe(false);
  });

  it("requires tx_hash + numeric block_number for onchain", () => {
    expect(validateRailReceipt("onchain", { tx_hash: "0x1", block_number: 42 }).ok).toBe(true);
    expect(validateRailReceipt("onchain", { tx_hash: "0x1", block_number: "42" }).ok).toBe(false);
    expect(validateRailReceipt("onchain", { tx_hash: "0x1" }).ok).toBe(false);
  });

  it("treats an untyped rail (null key) as ok", () => {
    expect(validateRailReceipt(null, {}).ok).toBe(true);
  });
});
