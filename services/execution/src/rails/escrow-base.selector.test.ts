/**
 * C1 regression: the escrow rail's function selector must match the contract.
 *
 * `escrow-base.ts` hand-writes the selector so the module stays SDK-free (no
 * viem import, so the rail is unit testable without viem/KMS/anvil). The
 * constant was wrong -- 0x84f97fba, which BrainEscrow does not dispatch at all.
 * The contract has no fallback function, so every escrow release reverted.
 *
 * `scripts/check-contract-abi-drift.mjs` could not catch it: that guard only
 * inspects `parseAbi([...])` blocks, and this was the one hand-rolled selector
 * in the repo. This test recomputes the selector from the signature so a wrong
 * constant fails here, and the guard now also rejects new hex selector literals.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, toHex } from "viem";

import { EscrowBaseRail } from "./escrow-base.js";
import type { OnchainExecuteArgs, OnchainExecuteResult } from "./onchain-base.js";

const RELEASE_SIGNATURE = "release(bytes32,uint256)";

/** The selector the deployed BrainEscrow actually dispatches. */
const EXPECTED_SELECTOR = keccak256(toHex(RELEASE_SIGNATURE)).slice(0, 10);

const SMART_ACCOUNT = "0x" + "11".repeat(20);
const HOLDER = "0x" + "22".repeat(20);
const ESCROW = "0x" + "33".repeat(20);
const ESCROW_ID = "0x" + "ab".repeat(32);

function makeRail(capture: { data?: string }) {
  const executor = {
    readNonce: async () => 0n,
    execute: async (args: OnchainExecuteArgs): Promise<OnchainExecuteResult> => {
      capture.data = args.data;
      return { txHash: "0x" + "99".repeat(32), blockNumber: 1n, gasUsed: 21_000n };
    },
  };
  return new EscrowBaseRail({
    executor,
    escrowAddress: ESCROW,
    holderAddress: HOLDER,
    smartAccount: SMART_ACCOUNT,
  });
}

function dispatchInput(action: Record<string, unknown>) {
  return { action } as never;
}

describe("escrow rail release selector", () => {
  it("is the real keccak256 selector for release(bytes32,uint256)", () => {
    expect(EXPECTED_SELECTOR).toBe("0x66afd8ef");
  });

  it("encodes calldata with the selector BrainEscrow dispatches", async () => {
    const capture: { data?: string } = {};
    await makeRail(capture).dispatch(
      dispatchInput({ escrow_id: ESCROW_ID, amount_units: "1000000" }),
    );

    expect(capture.data).toBeDefined();
    const data = capture.data as string;
    expect(data.slice(0, 10)).toBe(EXPECTED_SELECTOR);
    // selector + bytes32 escrowId + uint256 amount
    expect(data.length).toBe(2 + 8 + 64 + 64);
    expect(data.slice(10, 74)).toBe(ESCROW_ID.slice(2));
    expect(BigInt("0x" + data.slice(74))).toBe(1_000_000n);
  });

  it("pins the source constant so a hand-edit cannot silently drift", () => {
    const src = readFileSync(fileURLToPath(new URL("./escrow-base.ts", import.meta.url)), "utf8");
    const match = /const RELEASE_SELECTOR = "(0x[0-9a-fA-F]{8})"/.exec(src);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(EXPECTED_SELECTOR);
  });
});

describe("escrow rail amount validation", () => {
  it("rejects a fractional amount as validation_failed rather than throwing", async () => {
    const capture: { data?: string } = {};
    const rail = makeRail(capture);
    // BigInt("1.5") throws a bare SyntaxError; the old decimal regex admitted
    // it, so the error escaped as an uncaught TypeError instead of a
    // brainError the caller could classify.
    await expect(
      rail.dispatch(dispatchInput({ escrow_id: ESCROW_ID, amount_units: "1.5" })),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(capture.data).toBeUndefined();
  });

  it("rejects an amount that does not fit a uint256 word", async () => {
    const capture: { data?: string } = {};
    const rail = makeRail(capture);
    const tooBig = (1n << 256n).toString();
    await expect(
      rail.dispatch(dispatchInput({ escrow_id: ESCROW_ID, amount_units: tooBig })),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(capture.data).toBeUndefined();
  });

  it("accepts a plain base-unit integer", async () => {
    const capture: { data?: string } = {};
    const rail = makeRail(capture);
    const result = await rail.dispatch(
      dispatchInput({ escrow_id: ESCROW_ID, amount_units: "250000" }),
    );
    expect(result.receipt["released_units"]).toBe("250000");
    expect(capture.data?.slice(0, 10)).toBe(EXPECTED_SELECTOR);
  });
});
