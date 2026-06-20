/**
 * Testnet on-chain executor E2E (Base Sepolia) — Review 3 P0 8.1.
 *
 * Drives the REAL `OnchainBaseRail` (@brain/execution) against a REAL deployed
 * `BrainSmartAccount`, so "the on-chain rail works against the contract" is
 * proven, not just unit-mocked. The viem executor here mirrors the production
 * one (services/api/src/rails/onchainExecutor.ts); the rail under test — nonce
 * read, executeViaSessionKey, revert + permanent-failure classification — is the
 * shipped code.
 *
 * Dormant-but-ready scaffolding: it SELF-SKIPS without testnet env, and its CI
 * job (.github/workflows/main.yml: testnet_onchain_executor_e2e) is gated behind
 * `vars.TESTNET_ONCHAIN_E2E_ENABLED`, so a green check always means a real run.
 *
 * Env:
 *   BRAIN_TESTNET_RPC_URL        Base Sepolia RPC (required for any case)
 *   BRAIN_TESTNET_SMART_ACCOUNT  deployed BrainSmartAccount address (required)
 *   BRAIN_TESTNET_CHAIN_ID       default 84532
 *   BRAIN_TESTNET_SESSION_KEY    0x 32-byte priv key, gas-funded; the holder
 *                                (revert + success cases; spends only gas)
 *   BRAIN_TESTNET_TARGET         call target (revert + success cases)
 *   BRAIN_TESTNET_POLICY_VERSION 0x 32-byte policy digest the key is bound to
 *   BRAIN_TESTNET_SUCCESS_ENABLED  "true" to run the value-moving success case
 *                                  (needs a GRANTED session key + allowlisted
 *                                  target + funded account — see README)
 */

import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseAbi, parseGwei, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { OnchainBaseRail, type OnchainExecutor } from "@brain/execution";
import { isBrainError } from "@brain/shared";

const RPC = process.env.BRAIN_TESTNET_RPC_URL;
const SMART_ACCOUNT = process.env.BRAIN_TESTNET_SMART_ACCOUNT;
const SESSION_KEY = process.env.BRAIN_TESTNET_SESSION_KEY as Hex | undefined;
const TARGET = process.env.BRAIN_TESTNET_TARGET;
const CHAIN_ID = Number(process.env.BRAIN_TESTNET_CHAIN_ID ?? "84532");
const POLICY_VERSION = process.env.BRAIN_TESTNET_POLICY_VERSION ?? `0x${"00".repeat(32)}`;
const SUCCESS_ENABLED = process.env.BRAIN_TESTNET_SUCCESS_ENABLED === "true";

const ABI = parseAbi([
  "function nonce(address holder) external view returns (uint256)",
  "function executeViaSessionKey(uint256 nonceSupplied, address target, uint256 value, bytes calldata data) external",
]);

/** Build the on-chain executor (mirrors services/api/src/rails/onchainExecutor.ts). */
function buildExecutor(privateKey: Hex): OnchainExecutor {
  const chain = CHAIN_ID === 8453 ? base : baseSepolia;
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
  return {
    async readNonce(args) {
      return publicClient.readContract({
        address: args.smartAccount as Hex,
        abi: ABI,
        functionName: "nonce",
        args: [args.holder as Hex],
      });
    },
    async execute(args) {
      const hash = await walletClient.writeContract({
        address: args.smartAccount as Hex,
        abi: ABI,
        functionName: "executeViaSessionKey",
        args: [args.nonce, args.target as Hex, args.value, args.data as Hex],
        maxFeePerGas: parseGwei("3"),
        maxPriorityFeePerGas: parseGwei("1.5"),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return {
        txHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      };
    },
  };
}

/** Wrap an action in a RailDispatchInput; the rail only reads `action`. */
function railInput(action: Record<string, unknown>) {
  return {
    tenantId: "tnt_testnet_e2e",
    proposalId: "prop_testnet_e2e",
    executionId: "exec_testnet_e2e",
    idempotencyKey: "testnet-e2e",
    action,
  };
}

const readGate = RPC !== undefined && SMART_ACCOUNT !== undefined ? describe : describe.skip;

readGate("on-chain executor testnet — read path (requires RPC + smart account)", () => {
  it("reads the session-key nonce from the deployed BrainSmartAccount", async () => {
    const executor = buildExecutor(SESSION_KEY ?? (`0x${"11".repeat(32)}` as Hex));
    const holder = privateKeyToAccount(SESSION_KEY ?? (`0x${"11".repeat(32)}` as Hex)).address;
    const nonce = await executor.readNonce({ smartAccount: SMART_ACCOUNT!, holder });
    expect(typeof nonce).toBe("bigint");
    expect(nonce >= 0n).toBe(true);
  });
});

const revertGate =
  RPC !== undefined &&
  SMART_ACCOUNT !== undefined &&
  SESSION_KEY !== undefined &&
  TARGET !== undefined
    ? describe
    : describe.skip;

revertGate("on-chain executor testnet — revert path (gas only, no value moved)", () => {
  it("surfaces a real on-chain revert as execution_rail_declined", async () => {
    // The session key is NOT granted for this action (or the action is otherwise
    // rejected by the contract), so executeViaSessionKey reverts. viem's gas
    // estimation reverts, the executor throws, and the rail maps it to a
    // BrainError. This proves the revert path works against on-chain reverts,
    // not just mocked ones.
    const rail = new OnchainBaseRail({ executor: buildExecutor(SESSION_KEY!) });
    const holder = privateKeyToAccount(SESSION_KEY!).address;
    let thrown: unknown;
    try {
      await rail.dispatch(
        railInput({
          smart_account: SMART_ACCOUNT!,
          holder,
          target: TARGET!,
          value: "0",
          data: "0x", // empty call; rejected absent a matching grant
          policy_version: POLICY_VERSION,
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "expected the on-chain revert to surface").toBeDefined();
    expect(isBrainError(thrown) && thrown.code === "execution_rail_declined").toBe(true);
  });
});

const successGate = revertGate === describe && SUCCESS_ENABLED ? describe : describe.skip;

successGate(
  "on-chain executor testnet — success + on-chain replay guard (granted-key fixture)",
  () => {
    // Requires a GRANTED session key (target + selector allowlisted, cap >= value,
    // policy_version matching) on a funded BrainSmartAccount. See tests/e2e/README.md.
    const SUCCESS_DATA = process.env.BRAIN_TESTNET_SUCCESS_DATA ?? "0x";
    const SUCCESS_VALUE = process.env.BRAIN_TESTNET_SUCCESS_VALUE ?? "0";

    it("executes once, then a re-send at the CONSUMED nonce reverts (replay guard)", async () => {
      const executor = buildExecutor(SESSION_KEY!);
      const rail = new OnchainBaseRail({ executor });
      const action = {
        smart_account: SMART_ACCOUNT!,
        holder: privateKeyToAccount(SESSION_KEY!).address,
        target: TARGET!,
        value: SUCCESS_VALUE,
        data: SUCCESS_DATA,
        policy_version: POLICY_VERSION,
      };

      // First dispatch executes and consumes nonce N (the rail reads the live
      // nonce and threads it into executeViaSessionKey).
      const result = await rail.dispatch(railInput(action));
      expect(result.receipt.rail).toBe("onchain");
      expect(String(result.receipt.tx_hash).startsWith("0x")).toBe(true);
      const consumedNonce = BigInt(String(result.receipt.nonce));

      // The replay guard, asserted DIRECTLY: re-send at the CONSUMED nonce N
      // (bypassing the rail's live-nonce read, which would otherwise pick up the
      // advanced N+1). The on-chain H-03 nonce guard MUST revert (BadNonce), so
      // the same signed call can never land twice. This is the real exactly-once
      // backstop — NOT re-calling rail.dispatch (which reads a fresh nonce and
      // would simply do a second transfer). Outbox idempotency (same
      // idempotency_key -> one economic effect) is proved separately in the
      // execution outbox suite, not here.
      await expect(
        executor.execute({
          smartAccount: SMART_ACCOUNT!,
          holder: action.holder,
          nonce: consumedNonce,
          target: TARGET!,
          value: BigInt(SUCCESS_VALUE),
          data: SUCCESS_DATA,
        }),
      ).rejects.toThrow();
    });
  },
);
