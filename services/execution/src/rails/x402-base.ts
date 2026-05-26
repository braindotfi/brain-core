/**
 * x402 settlement rail (v0.4 / RFC 0001 §7.3) — USDC on Base.
 *
 * Settles a machine-to-machine (x402) payment in USDC on Base per the payment
 * requirements carried on the PaymentIntent's action. Like the other real rails
 * it depends on an injected client (`X402Client`) so it is fully unit-testable
 * without the x402 facilitator SDK / viem / KMS; the concrete client + boot
 * registration are the deferred "live wiring" step (mirrors AchPlaidRail /
 * OnchainBaseRail — see services/execution/README.md).
 *
 * Shadow-first: this rail is NOT registered at boot until x402 credentials are
 * configured, and the commerce agent that would propose `x402_settle` is not in
 * LIVE_AGENTS. Until both land, RailRegistry.get('x402_base') fails closed with
 * execution_rail_unavailable. Every x402 settlement still flows through the same
 * PaymentIntent → §6 gate → audit path — there is no separate un-gated path.
 */

import { brainError } from "@brain/shared";
import type { Rail, RailDispatchInput, RailDispatchResult } from "./types.js";

/** Settled asset is USDC on Base (decision D-4). */
const ASSET = "USDC";
const NETWORK = "base";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

export interface X402SettleArgs {
  /** Recipient address (the payee). */
  payTo: string;
  /** Settled amount as a decimal string (USDC). */
  amount: string;
  /** Idempotency key — a re-settle with the same key returns the same result. */
  idempotencyKey: string;
}

export interface X402SettleResult {
  /** On-chain settlement tx hash (the audit/reconciliation proof). */
  txHash: string;
  /** Amount actually settled (decimal string). */
  settledAmount: string;
}

/**
 * The x402 settlement surface the rail uses. The concrete implementation
 * (Coinbase x402 facilitator / a viem USDC transfer signed via the session key)
 * is built at boot and injected — keeping this module SDK-free and unit-testable.
 */
export interface X402Client {
  settle(args: X402SettleArgs): Promise<X402SettleResult>;
}

interface X402Action {
  asset: string;
  network: string;
  amount: string;
  pay_to: string;
}

function parseX402Action(action: Record<string, unknown>): X402Action {
  const asset = action["asset"];
  const network = action["network"];
  const amount = action["amount"];
  const payTo = action["pay_to"];
  if (asset !== ASSET) {
    throw brainError("validation_failed", `x402 action asset must be ${ASSET}`);
  }
  if (network !== NETWORK) {
    throw brainError("validation_failed", `x402 action network must be ${NETWORK}`);
  }
  if (typeof amount !== "string" || !DECIMAL.test(amount)) {
    throw brainError("validation_failed", "x402 action requires a decimal amount string");
  }
  if (typeof payTo !== "string" || !ADDRESS.test(payTo)) {
    throw brainError("validation_failed", "x402 action requires a 0x pay_to address");
  }
  return { asset, network, amount, pay_to: payTo };
}

function declineReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface X402BaseRailDeps {
  client: X402Client;
}

export class X402BaseRail implements Rail {
  public readonly kind = "x402_base" as const;
  private readonly client: X402Client;

  public constructor(deps: X402BaseRailDeps) {
    this.client = deps.client;
  }

  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    const action = parseX402Action(input.action);

    let result: X402SettleResult;
    try {
      result = await this.client.settle({
        payTo: action.pay_to,
        amount: action.amount,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (err) {
      throw brainError("execution_rail_declined", `x402 settle failed: ${declineReason(err)}`, {
        details: { pay_to: action.pay_to, amount: action.amount },
        cause: err,
      });
    }

    return {
      receipt: {
        rail: "x402",
        asset: action.asset,
        network: action.network,
        tx_hash: result.txHash,
        settled_amount: result.settledAmount,
        pay_to: action.pay_to,
      },
    };
  }
}
