/**
 * H-06 — On-chain Base rail via BrainSmartAccount.
 *
 * Replaces the fabricated `0xstub…` receipt (rails/stubs.ts) with a real call to
 * `BrainSmartAccount.executeViaSessionKey(nonce, target, value, data)` on Base.
 *
 * H-03 threading: the contract now enforces a per-holder replay nonce, so the
 * rail MUST read the current nonce (`getSessionKeyNonce`) and thread it into the
 * call. A stale nonce reverts on-chain with `BadNonce`; a re-entrant target
 * reverts with `ReentrantCall`. Both surface here as `execution_rail_declined`.
 *
 * PolicyVersion is bound to the session key at GRANT time (H-03 moved the
 * zero-check into grantSessionKey), so `executeViaSessionKey` takes no policy
 * argument — the rail carries `policy_version` only for the receipt/traceability
 * and validates its shape.
 *
 * Dependency injection + KMS safety: this module does NOT import `viem`,
 * `@azure/keyvault-keys`, or `@azure/identity`. It depends on a minimal
 * `OnchainExecutor` (read nonce + send the execute tx). The real executor is
 * built at boot from a viem wallet client whose Account proxies signing to Azure
 * Key Vault — the raw private key is NEVER read into process memory (§Secrets).
 * See services/execution/README.md. (Sandbox: viem/@azure are not installed and
 * there is no anvil, so the live executor + anvil round-trip are blocked here.)
 */

import { brainError } from "@brain/shared";
import type { Rail, RailDispatchInput, RailDispatchResult } from "./types.js";

/** Reads BrainSmartAccount.nonce(holder) — the next expected execute nonce. */
export interface SessionKeyNonceReader {
  readNonce(args: { smartAccount: string; holder: string }): Promise<bigint>;
}

export interface OnchainExecuteArgs {
  /** The per-tenant BrainSmartAccount address. */
  smartAccount: string;
  /** The session-key holder (the worker principal); also the tx signer. */
  holder: string;
  /** H-03 replay nonce, read immediately before sending. */
  nonce: bigint;
  /** Call target (e.g. the USDC token contract). */
  target: string;
  /** Native value in wei. */
  value: bigint;
  /** 0x-hex calldata (e.g. an encoded ERC20 transfer). */
  data: string;
}

export interface OnchainExecuteResult {
  txHash: string;
  blockNumber: bigint;
  gasUsed: bigint;
}

/**
 * The on-chain surface the rail uses. The concrete implementation is a
 * viem-backed client signing through Azure Key Vault. Injected so the rail is
 * fully unit-testable without viem/KMS/anvil.
 */
export interface OnchainExecutor extends SessionKeyNonceReader {
  execute(args: OnchainExecuteArgs): Promise<OnchainExecuteResult>;
}

/**
 * H-03 off-chain helper: read the current session-key nonce for `holder` on a
 * given BrainSmartAccount. The H-06 rail threads the result into the execute
 * call so the on-chain replay guard accepts it.
 */
export async function getSessionKeyNonce(
  reader: SessionKeyNonceReader,
  smartAccount: string,
  holder: string,
): Promise<bigint> {
  return reader.readNonce({ smartAccount, holder });
}

export interface OnchainBaseAction {
  /** The BrainSmartAccount this call routes through. */
  smart_account: string;
  /** The session-key holder / signer. */
  holder: string;
  /** Call target. */
  target: string;
  /** Wei as a decimal-integer string; defaults to "0". */
  value?: string;
  /** 0x-hex calldata. */
  data: string;
  /** 0x 32-byte policy digest the key is bound to (pre-checked at grant). */
  policy_version: string;
}

const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POLICY_VERSION = /^0x[0-9a-fA-F]{64}$/;

function parseOnchainAction(action: Record<string, unknown>): OnchainBaseAction {
  const smartAccount = action["smart_account"];
  const holder = action["holder"];
  const target = action["target"];
  const data = action["data"];
  const policyVersion = action["policy_version"];
  if (typeof smartAccount !== "string" || !ADDRESS.test(smartAccount)) {
    throw brainError("validation_failed", "onchain action requires a 0x smart_account address");
  }
  if (typeof holder !== "string" || !ADDRESS.test(holder)) {
    throw brainError("validation_failed", "onchain action requires a 0x holder address");
  }
  if (typeof target !== "string" || !ADDRESS.test(target)) {
    throw brainError("validation_failed", "onchain action requires a 0x target address");
  }
  if (typeof data !== "string" || !HEX_DATA.test(data)) {
    throw brainError("validation_failed", "onchain action requires 0x-hex calldata");
  }
  if (typeof policyVersion !== "string" || !POLICY_VERSION.test(policyVersion)) {
    throw brainError("validation_failed", "onchain action requires a 0x 32-byte policy_version");
  }
  const out: OnchainBaseAction = {
    smart_account: smartAccount,
    holder,
    target,
    data,
    policy_version: policyVersion,
  };
  const value = action["value"];
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      throw brainError("validation_failed", "onchain action value must be a wei integer string");
    }
    out.value = value;
  }
  return out;
}

function revertReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface OnchainBaseRailDeps {
  executor: OnchainExecutor;
}

export class OnchainBaseRail implements Rail {
  public readonly kind = "onchain_base" as const;
  private readonly executor: OnchainExecutor;

  public constructor(deps: OnchainBaseRailDeps) {
    this.executor = deps.executor;
  }

  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    const action = parseOnchainAction(input.action);

    // H-03: read the live nonce and thread it into the execute call. A racing
    // re-dispatch reads the same nonce and the second send reverts with
    // BadNonce — the on-chain replay guard backs the outbox's exactly-once.
    const nonce = await getSessionKeyNonce(this.executor, action.smart_account, action.holder);

    let result: OnchainExecuteResult;
    try {
      result = await this.executor.execute({
        smartAccount: action.smart_account,
        holder: action.holder,
        nonce,
        target: action.target,
        value: action.value === undefined ? 0n : BigInt(action.value),
        data: action.data,
      });
    } catch (err) {
      // BadNonce (replay), ReentrantCall, cap/allowlist reverts all land here.
      throw brainError(
        "execution_rail_declined",
        `on-chain execute reverted: ${revertReason(err)}`,
        {
          details: { nonce: nonce.toString(), policy_version: action.policy_version },
          cause: err,
        },
      );
    }

    return {
      receipt: {
        rail: "onchain",
        tx_hash: result.txHash,
        block_number: Number(result.blockNumber),
        gas_used: result.gasUsed.toString(),
        nonce: nonce.toString(),
        policy_version: action.policy_version,
      },
    };
  }
}
