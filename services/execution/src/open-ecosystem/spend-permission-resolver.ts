/**
 * Open-ecosystem settlement resolver (RFC 0001 §7.5, Phase 4-B).
 *
 * Resolves a validated Coinbase **Spend Permission** into an `x402_settle` create
 * payload. The resulting PaymentIntent flows through the SAME create → §6 gate →
 * audit path as the internal session-key flow — the gate is **source-agnostic**,
 * so an external 4337 / Coinbase Smart Wallet payment is gated identically. This
 * is the open-ecosystem *entry*, never an un-gated path.
 *
 * Mirrors the P0.5 invoice-shortcut resolver pattern: every unresolved input is a
 * specific `open_ecosystem_*` 4xx (fail-closed). The on-chain `spend` /
 * gasless `UserOperation` (CDP Paymaster) is the deferred settlement step (4-C);
 * this resolver only assembles the gated proposal.
 */

import { brainError, type ServiceCallContext } from "@brain/shared";
import { validateSpendPermission, type SpendPermission } from "./spend-permission.js";

export interface SpendPermissionResolverDeps {
  /** Configured USDC-on-Base token address (D-4). The permission's token must equal this. */
  readonly usdcAddress: string;
  /** Resolve the buyer's smart-wallet ledger account id by its on-chain address. null ⇒ not onboarded. */
  readonly resolveWalletAccount: (
    ctx: ServiceCallContext,
    walletAddress: string,
  ) => Promise<string | null>;
  /** Resolve the payee agent counterparty id by the spender's on-chain address. null ⇒ unknown/unattested. */
  readonly resolvePayeeCounterparty: (
    ctx: ServiceCallContext,
    spenderAddress: string,
  ) => Promise<string | null>;
  /** Current time (unix seconds); injected for determinism. */
  readonly now: () => number;
}

/** An x402_settle create payload resolved from a Spend Permission. */
export interface ResolvedSpendPermissionIntent {
  readonly action_type: "x402_settle";
  readonly source_account_id: string;
  readonly destination_counterparty_id: string;
  readonly amount: string;
  readonly currency: "USDC";
  readonly pay_to: string;
}

export async function resolveSpendPermissionSettlement(
  deps: SpendPermissionResolverDeps,
  ctx: ServiceCallContext,
  input: { permission: SpendPermission; amount: string },
): Promise<ResolvedSpendPermissionIntent> {
  const { permission, amount } = input;

  // 1. The permission must authorize this settlement: USDC, amount ≤ allowance,
  //    within [start,end], well-formed. (In the simple path the permission's
  //    `spender` IS the payee that pulls funds.)
  const validation = validateSpendPermission(permission, {
    token: deps.usdcAddress,
    spender: permission.spender,
    amount,
    nowSeconds: deps.now(),
  });
  if (!validation.valid) {
    throw brainError(
      "open_ecosystem_invalid_permission",
      "spend permission does not authorize this settlement",
      { details: { failures: validation.failures } },
    );
  }

  // 2. The payee (the permission's spender) must be a known/attested agent
  //    counterparty — the §6 gate (check 5.5) attests it again at execute time.
  const payee = await deps.resolvePayeeCounterparty(ctx, permission.spender);
  if (payee === null) {
    throw brainError(
      "open_ecosystem_unknown_payee",
      "permission spender is not a registered payee counterparty",
      { details: { spender: permission.spender } },
    );
  }

  // 3. The funding smart wallet must have a Brain source account.
  const source = await deps.resolveWalletAccount(ctx, permission.account);
  if (source === null) {
    throw brainError("open_ecosystem_unknown_wallet", "smart wallet has no Brain source account", {
      details: { account: permission.account },
    });
  }

  return {
    action_type: "x402_settle",
    source_account_id: source,
    destination_counterparty_id: payee,
    amount,
    currency: "USDC",
    pay_to: permission.spender,
  };
}
