import { afterEach, describe, expect, it } from "vitest";
import {
  BankAchStubRail,
  ErpWritebackStubRail,
  OnchainBaseStubRail,
  defaultRails,
} from "./stubs.js";
import type { RailDispatchInput } from "./types.js";

const INPUT: RailDispatchInput = {
  tenantId: "tnt_01TEST00000000000000000000",
  proposalId: "prp_01TEST0000000000000000000",
  executionId: "exec_01TEST000000000000000000",
  action: { kind: "wire", amount: "100000.00", currency: "USD" },
  idempotencyKey: "k",
};

const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe("stub rails — production fail-closed guard", () => {
  it("every stub rail refuses to dispatch (fake-settle) under NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";
    await expect(new BankAchStubRail().dispatch(INPUT)).rejects.toThrow(/production/i);
    await expect(new ErpWritebackStubRail().dispatch(INPUT)).rejects.toThrow(/production/i);
    await expect(new OnchainBaseStubRail().dispatch(INPUT)).rejects.toThrow(/production/i);
  });

  it("defaultRails() refuses to construct stub rails under NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    expect(() => defaultRails()).toThrow(/production/i);
  });

  it("still dispatches a stub receipt outside production", async () => {
    process.env.NODE_ENV = "test";
    const result = await new BankAchStubRail().dispatch(INPUT);
    expect(result.receipt.stub).toBe(true);
    expect(() => defaultRails()).not.toThrow();
  });
});
