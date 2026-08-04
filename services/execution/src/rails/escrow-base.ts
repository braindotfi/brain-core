/**
 * Escrow release rail (v0.4 / RFC 0001 §7.6) — BrainEscrow.release on Base.
 *
 * Releases a (partial) milestone from a Locked BrainEscrow to its payee.
 * Reuses the OnchainExecutor from the onchain-base rail (same session-key +
 * viem path); the escrow address is the only delta. Like all real rails, the
 * concrete executor is injected at boot — this module is SDK-free and fully
 * unit-testable without viem/KMS/anvil.
 *
 * Shadow-first: this rail is NOT registered at boot until BRAIN_ESCROW_ADDRESS
 * is configured. Until then RailRegistry.get('escrow_base') fails closed with
 * execution_rail_unavailable. Every escrow release still flows through the same
 * PaymentIntent → §6 gate (check 6.6: escrow-state-binding) → audit path.
 */

import { brainError } from "@brain/shared";
import type { Rail, RailDispatchInput, RailDispatchResult } from "./types.js";
import type { OnchainExecutor } from "./onchain-base.js";

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/**
 * `amount_units` is a base-unit integer. It is deliberately NOT `\d+(\.\d+)?`:
 * that admitted "1.5", which `BigInt()` then threw a bare SyntaxError on,
 * escaping as an uncaught TypeError instead of a `validation_failed`.
 */
const BASE_UNITS = /^\d+$/;

/**
 * Selector for `BrainEscrow.release(bytes32,uint256)`.
 *
 * Pinned by escrow-base.selector.test.ts, which recomputes it from the
 * signature. It was previously hand-written as 0x84f97fba, which is not a
 * selector BrainEscrow dispatches at all: since the contract has no fallback,
 * every release reverted. `scripts/check-contract-abi-drift.mjs` could not see
 * it because the guard only inspected `parseAbi([...])` blocks; it now also
 * registers and checks hand-rolled selectors.
 *
 * This module stays SDK-free on purpose (no viem import) so the rail is unit
 * testable without viem/KMS/anvil, which is why the constant is not derived at
 * runtime. The test is what keeps it honest.
 */
const RELEASE_SELECTOR = "0x66afd8ef";

/** uint256 ceiling, so a malformed amount cannot overflow the 32-byte word. */
const UINT256_MAX = (1n << 256n) - 1n;

interface EscrowReleaseAction {
  escrow_id: string;
  amount_units: string;
}

function parseEscrowAction(action: Record<string, unknown>): EscrowReleaseAction {
  const escrowId = action["escrow_id"];
  const amountUnits = action["amount_units"];
  if (typeof escrowId !== "string" || !BYTES32.test(escrowId)) {
    throw brainError("validation_failed", "escrow_release action requires a 0x 32-byte escrow_id");
  }
  if (typeof amountUnits !== "string" || !BASE_UNITS.test(amountUnits)) {
    throw brainError(
      "validation_failed",
      "escrow_release action requires an integer amount_units in base units",
    );
  }
  if (BigInt(amountUnits) > UINT256_MAX) {
    throw brainError("validation_failed", "escrow_release amount_units exceeds uint256");
  }
  return { escrow_id: escrowId, amount_units: amountUnits };
}

/** ABI-encode BrainEscrow.release(bytes32 escrowId, uint256 amount). */
function encodeRelease(escrowId: string, amountUnits: string): string {
  // bytes32 escrowId — already 32 bytes (0x-prefixed), no padding needed.
  // uint256 amount   — left-pad BigInt to 32 bytes. parseEscrowAction has
  //                    already proved this parses and fits.
  const escrowHex = escrowId.slice(2); // strip 0x
  const amountHex = BigInt(amountUnits).toString(16).padStart(64, "0");
  return `${RELEASE_SELECTOR}${escrowHex}${amountHex}`;
}

function revertReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface EscrowBaseRailDeps {
  executor: OnchainExecutor;
  /** 0x 20-byte BrainEscrow contract address. */
  escrowAddress: string;
  /** 0x 20-byte holder (session-key) address — used for nonce-reading. */
  holderAddress: string;
  /**
   * 0x 20-byte BrainSmartAccount address.
   *
   * The release IS routed through `BrainSmartAccount.executeViaSessionKey`, so
   * `msg.sender` at BrainEscrow is the SMART ACCOUNT, not the session-key EOA.
   * The smart account must therefore be the escrow's `payer` or its `arbiter`,
   * or `release` reverts with NotAuthorized. (This comment previously claimed
   * the opposite of what the code does, which is a live misconfiguration trap
   * at deploy time.)
   *
   * The session key must be granted in CALL mode with
   * `capAmountOffset = 36` — the offset of the uint256 `amount` word in
   * `release(bytes32,uint256)` calldata — so the release is metered by the
   * key's caps. In NATIVE mode it would be metered against msg.value, which is
   * always zero here.
   */
  smartAccount: string;
}

export class EscrowBaseRail implements Rail {
  public readonly kind = "escrow_base" as const;
  private readonly executor: OnchainExecutor;
  private readonly escrowAddress: string;
  private readonly holderAddress: string;
  private readonly smartAccount: string;

  public constructor(deps: EscrowBaseRailDeps) {
    this.executor = deps.executor;
    this.escrowAddress = deps.escrowAddress;
    this.holderAddress = deps.holderAddress;
    this.smartAccount = deps.smartAccount;
  }

  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    const action = parseEscrowAction(input.action);
    const data = encodeRelease(action.escrow_id, action.amount_units);

    // Route the release through BrainSmartAccount.executeViaSessionKey so the
    // session-key authorization chain is maintained: SmartAccount → BrainEscrow.
    const nonce = await this.executor.readNonce({
      smartAccount: this.smartAccount,
      holder: this.holderAddress,
    });

    let txHash: string;
    try {
      const result = await this.executor.execute({
        smartAccount: this.smartAccount,
        holder: this.holderAddress,
        nonce,
        target: this.escrowAddress,
        value: 0n,
        data,
      });
      txHash = result.txHash;
    } catch (err) {
      throw brainError("execution_rail_declined", `escrow release reverted: ${revertReason(err)}`, {
        details: { escrow_id: action.escrow_id, amount_units: action.amount_units },
        cause: err,
      });
    }

    return {
      receipt: {
        rail: "escrow",
        tx_hash: txHash,
        escrow_id: action.escrow_id,
        released_units: action.amount_units,
      },
    };
  }
}
