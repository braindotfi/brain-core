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
const DECIMAL = /^\d+(\.\d+)?$/;

/** ABI-encoded calldata for BrainEscrow.release(bytes32, uint256). */
const RELEASE_SELECTOR = "0x84f97fba"; // keccak256("release(bytes32,uint256)")[:4]

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
  if (typeof amountUnits !== "string" || !DECIMAL.test(amountUnits)) {
    throw brainError("validation_failed", "escrow_release action requires a decimal amount_units");
  }
  return { escrow_id: escrowId, amount_units: amountUnits };
}

/** ABI-encode BrainEscrow.release(bytes32 escrowId, uint256 amount). */
function encodeRelease(escrowId: string, amountUnits: string): string {
  // bytes32 escrowId — already 32 bytes (0x-prefixed), no padding needed.
  // uint256 amount   — left-pad BigInt to 32 bytes.
  const escrowHex = escrowId.slice(2); // strip 0x
  const amountBig = BigInt(amountUnits);
  const amountHex = amountBig.toString(16).padStart(64, "0");
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
  /** 0x 20-byte BrainSmartAccount address — the tx is sent via the session key, NOT through BrainSmartAccount.executeViaSessionKey. The escrow is called directly by the session-key EOA (the same EOA is the arbiter). */
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
