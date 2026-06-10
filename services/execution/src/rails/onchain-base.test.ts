/**
 * H-06 — On-chain Base rail tests.
 *
 * The anvil-backed integration test (deploy BrainSmartAccount + register policy
 * + grant key + dispatch + assert AgentActionExecuted) and the live viem + Azure
 * Key Vault signer are BLOCKED in this environment: viem / @azure are not
 * installed and there is no anvil. These tests exercise the rail logic against a
 * mock OnchainExecutor: nonce threading (H-03), the replay (BadNonce) and
 * re-entrancy (ReentrantCall) revert paths, and the KMS no-raw-key invariant.
 */

import { describe, expect, it, vi } from "vitest";
import { BrainError } from "@brain/shared";
import {
  OnchainBaseRail,
  getSessionKeyNonce,
  type OnchainExecuteArgs,
  type OnchainExecuteResult,
  type OnchainExecutor,
} from "./onchain-base.js";
import type { RailDispatchInput } from "./types.js";

const SMART_ACCOUNT = "0x1111111111111111111111111111111111111111";
const HOLDER = "0x2222222222222222222222222222222222222222";
const TARGET = "0x3333333333333333333333333333333333333333"; // e.g. USDC
const POLICY_VERSION = "0x" + "ab".repeat(32);
// transfer(address,uint256) selector + 0xBEEF recipient + 1,000,000 (1 USDC @6dp)
const CALLDATA =
  "0xa9059cbb" +
  "000000000000000000000000000000000000000000000000000000000000beef" +
  "00000000000000000000000000000000000000000000000000000000000f4240";

function dispatchInput(overrides: Partial<RailDispatchInput> = {}): RailDispatchInput {
  return {
    tenantId: "tnt_1",
    proposalId: "prop_1",
    executionId: "exec_1",
    idempotencyKey: "pi:pi_1:dec_1",
    action: {
      smart_account: SMART_ACCOUNT,
      holder: HOLDER,
      target: TARGET,
      value: "0",
      data: CALLDATA,
      policy_version: POLICY_VERSION,
    },
    ...overrides,
  };
}

function mockExecutor(opts?: {
  nonce?: bigint;
  executeImpl?: (args: OnchainExecuteArgs) => Promise<OnchainExecuteResult>;
}): {
  executor: OnchainExecutor;
  executeCalls: OnchainExecuteArgs[];
} {
  const executeCalls: OnchainExecuteArgs[] = [];
  const executor: OnchainExecutor = {
    readNonce: vi.fn(async () => opts?.nonce ?? 0n),
    execute: vi.fn(async (args: OnchainExecuteArgs) => {
      executeCalls.push(args);
      if (opts?.executeImpl) return opts.executeImpl(args);
      return { txHash: "0xdeadbeef", blockNumber: 123n, gasUsed: 45_000n };
    }),
  };
  return { executor, executeCalls };
}

describe("OnchainBaseRail.dispatch", () => {
  it("reads the live nonce and threads it into executeViaSessionKey", async () => {
    const { executor, executeCalls } = mockExecutor({ nonce: 5n });
    const rail = new OnchainBaseRail({ executor });

    const { receipt } = await rail.dispatch(dispatchInput());

    expect(executor.readNonce).toHaveBeenCalledWith({
      smartAccount: SMART_ACCOUNT,
      holder: HOLDER,
    });
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.nonce).toBe(5n);
    expect(executeCalls[0]?.target).toBe(TARGET);
    expect(executeCalls[0]?.data).toBe(CALLDATA);
    expect(executeCalls[0]?.value).toBe(0n);
    expect(receipt).toEqual({
      rail: "onchain",
      tx_hash: "0xdeadbeef",
      block_number: 123,
      gas_used: "45000",
      nonce: "5",
      policy_version: POLICY_VERSION,
    });
  });

  it("surfaces an on-chain BadNonce revert as execution_rail_declined (replay)", async () => {
    const { executor } = mockExecutor({
      executeImpl: async () => {
        throw new Error("execution reverted: BadNonce(6, 5)");
      },
    });
    const rail = new OnchainBaseRail({ executor });

    await expect(rail.dispatch(dispatchInput())).rejects.toMatchObject({
      code: "execution_rail_declined",
    });
  });

  it("does NOT tag BadNonce as permanent (a racing dispatch may have moved money)", async () => {
    const { executor } = mockExecutor({
      executeImpl: async () => {
        throw new Error("execution reverted: BadNonce(6, 5)");
      },
    });
    const rail = new OnchainBaseRail({ executor });

    await expect(rail.dispatch(dispatchInput())).rejects.toMatchObject({
      code: "execution_rail_declined",
      details: expect.not.objectContaining({ permanent_failure: true }),
    });
  });

  it("tags a deterministic revert (ExceedsPerTxCap selector) as a permanent failure", async () => {
    // The incident shape: viem cannot decode the custom error (not on the
    // call ABI) and reports the raw 4-byte signature.
    const { executor } = mockExecutor({
      executeImpl: async () => {
        throw new Error(
          'The contract function "executeViaSessionKey" reverted with the following signature:\n0x49aeece1',
        );
      },
    });
    const rail = new OnchainBaseRail({ executor });

    await expect(rail.dispatch(dispatchInput())).rejects.toMatchObject({
      code: "execution_rail_declined",
      details: expect.objectContaining({
        permanent_failure: true,
        decoded_revert: "ExceedsPerTxCap()",
      }),
    });
  });

  it("surfaces an on-chain ReentrantCall revert as execution_rail_declined", async () => {
    const { executor } = mockExecutor({
      executeImpl: async () => {
        throw new Error("execution reverted: ReentrantCall()");
      },
    });
    const rail = new OnchainBaseRail({ executor });

    await expect(rail.dispatch(dispatchInput())).rejects.toMatchObject({
      code: "execution_rail_declined",
    });
  });

  it("rejects malformed calldata before touching the chain", async () => {
    const { executor } = mockExecutor();
    const rail = new OnchainBaseRail({ executor });
    const bad = dispatchInput({
      action: {
        smart_account: SMART_ACCOUNT,
        holder: HOLDER,
        target: TARGET,
        data: "not-hex",
        policy_version: POLICY_VERSION,
      },
    });
    await expect(rail.dispatch(bad)).rejects.toBeInstanceOf(BrainError);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("rejects a policy_version that is not a 0x 32-byte digest", async () => {
    const { executor } = mockExecutor();
    const rail = new OnchainBaseRail({ executor });
    const bad = dispatchInput({
      action: {
        smart_account: SMART_ACCOUNT,
        holder: HOLDER,
        target: TARGET,
        data: CALLDATA,
        policy_version: "0x1234",
      },
    });
    await expect(rail.dispatch(bad)).rejects.toBeInstanceOf(BrainError);
  });

  it("KMS invariant: no raw 64-hex private key is ever passed to the executor", async () => {
    // The signer lives behind the injected executor (a KMS-backed viem account);
    // the rail must never carry raw key material. Assert no execute argument is
    // a 32-byte (64-hex) secret.
    const { executor, executeCalls } = mockExecutor({ nonce: 1n });
    const rail = new OnchainBaseRail({ executor });
    await rail.dispatch(dispatchInput());

    const rawKeyLike = /^0x[0-9a-fA-F]{64}$/;
    for (const call of executeCalls) {
      for (const value of Object.values(call)) {
        if (typeof value === "string") {
          expect(rawKeyLike.test(value)).toBe(false);
        }
      }
    }
  });
});

describe("getSessionKeyNonce", () => {
  it("delegates to the reader keyed by (smartAccount, holder)", async () => {
    const { executor } = mockExecutor({ nonce: 9n });
    const n = await getSessionKeyNonce(executor, SMART_ACCOUNT, HOLDER);
    expect(n).toBe(9n);
    expect(executor.readNonce).toHaveBeenCalledWith({
      smartAccount: SMART_ACCOUNT,
      holder: HOLDER,
    });
  });
});
