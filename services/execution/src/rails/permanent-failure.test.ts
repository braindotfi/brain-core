/**
 * Deterministic-revert classification tests.
 *
 * The classifier must catch the incident shape exactly: viem reports an
 * undecodable custom error as `reverted with the following signature:
 * 0x49aeece1`, nested arbitrarily deep in the `cause` chain — and must NOT
 * classify ambiguous reverts (BadNonce — a racing dispatch may have moved
 * money) or window-bound ones (ExceedsPerPeriodCap) as permanent.
 */

import { describe, expect, it } from "vitest";
import { brainError } from "@brain/shared";
import {
  DETERMINISTIC_SMART_ACCOUNT_REVERTS,
  classifyDeterministicRevert,
  permanentFailureReason,
} from "./permanent-failure.js";

describe("classifyDeterministicRevert", () => {
  it("decodes a raw 4-byte selector in the message (viem unknown-custom-error shape)", () => {
    const err = new Error(
      'The contract function "executeViaSessionKey" reverted with the following signature:\n0x49aeece1',
    );
    expect(classifyDeterministicRevert(err)).toBe("ExceedsPerTxCap()");
  });

  it("decodes by error name when the thrower's ABI already decoded it", () => {
    const err = new Error("execution reverted: PolicyVersionMismatch()");
    expect(classifyDeterministicRevert(err)).toBe("PolicyVersionMismatch()");
  });

  it("walks the cause chain (viem nests the revert data deep)", () => {
    const inner = new Error("reverted with the following signature: 0xe356c1d3");
    const outer = new Error("dispatch failed", { cause: inner });
    expect(classifyDeterministicRevert(outer)).toBe("TargetNotAllowed(address)");
  });

  it("matches selectors case-insensitively", () => {
    expect(classifyDeterministicRevert(new Error("sig: 0x49AEECE1"))).toBe("ExceedsPerTxCap()");
  });

  it("does NOT match a selector embedded in longer calldata hex", () => {
    // transfer(address,uint256) calldata starting 0xa9059cbb… — no boundary
    // after 8 hex chars, so the selector pattern must not fire.
    const err = new Error(
      "request failed for data 0xa9059cbb000000000000000000000000000000000000000000000000000000beef",
    );
    expect(classifyDeterministicRevert(err)).toBeNull();
  });

  it("returns null for ambiguous/transient reverts: BadNonce, ExceedsPerPeriodCap, pauses", () => {
    // BadNonce: a racing dispatch may have moved money — must stay on the
    // reconcile path, never permanent. The others are reversible over time.
    expect(classifyDeterministicRevert(new Error("BadNonce(3, 2)"))).toBeNull();
    expect(classifyDeterministicRevert(new Error("sig: 0x3ddd5131"))).toBeNull(); // BadNonce
    expect(classifyDeterministicRevert(new Error("sig: 0xada0a1db"))).toBeNull(); // ExceedsPerPeriodCap
    expect(classifyDeterministicRevert(new Error("KeyPaused()"))).toBeNull();
    expect(classifyDeterministicRevert(new Error("rail timeout"))).toBeNull();
    expect(classifyDeterministicRevert("plain string error")).toBeNull();
    expect(classifyDeterministicRevert(null)).toBeNull();
  });

  it("covers every table entry by selector and by name", () => {
    for (const { selector, signature } of DETERMINISTIC_SMART_ACCOUNT_REVERTS) {
      expect(classifyDeterministicRevert(new Error(`reverted: ${selector}`))).toBe(signature);
      expect(classifyDeterministicRevert(new Error(`reverted: ${signature}`))).toBe(signature);
    }
  });
});

describe("permanentFailureReason", () => {
  it("returns the decoded reason for a rail-tagged permanent BrainError", () => {
    const err = brainError("execution_rail_declined", "on-chain execute reverted: 0x49aeece1", {
      details: { permanent_failure: true, decoded_revert: "ExceedsPerTxCap()" },
    });
    const reason = permanentFailureReason(err);
    expect(reason).toContain("deterministic_revert ExceedsPerTxCap()");
    expect(reason).toContain("on-chain execute reverted");
  });

  it("returns null for untagged BrainErrors and plain errors", () => {
    const untagged = brainError("execution_rail_declined", "on-chain execute reverted: BadNonce", {
      details: { nonce: "3" },
    });
    expect(permanentFailureReason(untagged)).toBeNull();
    expect(permanentFailureReason(new Error("rail timeout"))).toBeNull();
    expect(permanentFailureReason(null)).toBeNull();
  });
});
