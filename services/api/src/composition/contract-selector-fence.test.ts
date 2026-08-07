import { describe, expect, it, vi } from "vitest";
import type { AbiFunction } from "viem";
import { assertDeployedContractSelectors, missingSelectors } from "./contract-selector-fence.js";

// The two functions at the centre of the #393 incident: anchorBatch was called
// against a contract that only had anchor.
const ANCHOR: AbiFunction = {
  name: "anchor",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "tenantId", type: "bytes32" },
    { name: "root", type: "bytes32" },
    { name: "eventCount", type: "uint256" },
    { name: "periodStart", type: "uint256" },
    { name: "periodEnd", type: "uint256" },
  ],
  outputs: [],
};
const ANCHOR_BATCH: AbiFunction = {
  name: "anchorBatch",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "tenantIds", type: "bytes32[]" },
    { name: "roots", type: "bytes32[]" },
    { name: "eventCounts", type: "uint256[]" },
    { name: "periodStarts", type: "uint256[]" },
    { name: "periodEnds", type: "uint256[]" },
  ],
  outputs: [],
};

/** The real anchorBatch selector, verified on-chain with `cast code`. */
const ANCHOR_BATCH_SELECTOR = "56994e60";

describe("missingSelectors", () => {
  it("reports a selector absent from the deployed dispatcher", () => {
    expect(missingSelectors("0x6080604052", [ANCHOR_BATCH])).toEqual([
      `anchorBatch(0x${ANCHOR_BATCH_SELECTOR})`,
    ]);
  });

  it("reports nothing when every selector is present", () => {
    expect(missingSelectors(`0x6080${ANCHOR_BATCH_SELECTOR}6040`, [ANCHOR_BATCH])).toEqual([]);
  });

  it("matches case-insensitively", () => {
    expect(
      missingSelectors(`0x6080${ANCHOR_BATCH_SELECTOR.toUpperCase()}`, [ANCHOR_BATCH]),
    ).toEqual([]);
  });
});

describe("assertDeployedContractSelectors", () => {
  const getCode = (code: string) => vi.fn(async () => code);

  it("throws in production when the deployed contract lacks a called function", async () => {
    await expect(
      assertDeployedContractSelectors({
        nodeEnv: "production",
        expectations: [
          {
            contractName: "BrainAuditAnchor",
            address: "0xb900add824064098342c869ff83efdeb05eb95ce",
            requiredFunctions: [ANCHOR, ANCHOR_BATCH],
          },
        ],
        getCode: getCode("0x6080604052"),
      }),
    ).rejects.toThrow(/does not expose anchor\(/);
  });

  it("throws when the address holds no contract at all", async () => {
    await expect(
      assertDeployedContractSelectors({
        nodeEnv: "production",
        expectations: [
          {
            contractName: "BrainAuditAnchor",
            address: "0x0000000000000000000000000000000000000001",
            requiredFunctions: [ANCHOR_BATCH],
          },
        ],
        getCode: getCode("0x"),
      }),
    ).rejects.toThrow(/holds no contract/);
  });

  it("is silent when the address is not configured", async () => {
    const probe = getCode("0x");
    await expect(
      assertDeployedContractSelectors({
        nodeEnv: "production",
        expectations: [
          { contractName: "BrainAuditAnchor", address: undefined, requiredFunctions: [ANCHOR] },
        ],
        getCode: probe,
      }),
    ).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not reach the RPC outside staging/production", async () => {
    const probe = getCode("0x6080604052");
    await expect(
      assertDeployedContractSelectors({
        nodeEnv: "development",
        expectations: [
          {
            contractName: "BrainAuditAnchor",
            address: "0xb900add824064098342c869ff83efdeb05eb95ce",
            requiredFunctions: [ANCHOR_BATCH],
          },
        ],
        getCode: probe,
      }),
    ).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("passes when every required selector is deployed", async () => {
    await expect(
      assertDeployedContractSelectors({
        nodeEnv: "staging",
        expectations: [
          {
            contractName: "BrainAuditAnchor",
            address: "0xab0eac4a000000000000000000000000000000ab",
            requiredFunctions: [ANCHOR_BATCH],
          },
        ],
        getCode: getCode(`0x6080${ANCHOR_BATCH_SELECTOR}6040`),
      }),
    ).resolves.toBeUndefined();
  });
});
