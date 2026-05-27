/**
 * Tests for the open-ecosystem settlement resolver (RFC 0001 §7.5, Phase 4-B).
 *
 * Proves an external Coinbase Smart Wallet Spend Permission resolves to a valid
 * `x402_settle` create payload — which then flows through the SAME create → §6
 * gate → audit path (the gate is source-agnostic). Fail-closed with specific
 * `open_ecosystem_*` errors.
 */

import { describe, expect, it } from "vitest";
import { BrainError, type ServiceCallContext } from "@brain/shared";
import {
  resolveSpendPermissionSettlement,
  type SpendPermissionResolverDeps,
} from "./spend-permission-resolver.js";
import type { SpendPermission } from "./spend-permission.js";

const USDC = "0x" + "ab".repeat(20);
const PAYEE = "0x" + "cd".repeat(20); // the permission spender (seller agent)
const WALLET = "0x" + "ef".repeat(20); // the buyer's Coinbase Smart Wallet
const SALT = "0x" + "12".repeat(32);
const ctx: ServiceCallContext = { tenantId: "tnt_1", actor: "agent_x" };

function permission(overrides: Partial<SpendPermission> = {}): SpendPermission {
  return {
    account: WALLET,
    spender: PAYEE,
    token: USDC,
    allowance: "100.00",
    period: 86_400,
    start: 1_000,
    end: 2_000_000,
    salt: SALT,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SpendPermissionResolverDeps> = {},
): SpendPermissionResolverDeps {
  return {
    usdcAddress: USDC,
    resolveWalletAccount: async () => "acct_wallet",
    resolvePayeeCounterparty: async () => "cp_payee",
    now: () => 50_000,
    ...overrides,
  };
}

describe("resolveSpendPermissionSettlement", () => {
  it("resolves a valid permission to an x402_settle create payload", async () => {
    const out = await resolveSpendPermissionSettlement(makeDeps(), ctx, {
      permission: permission(),
      amount: "10.00",
    });
    expect(out).toEqual({
      action_type: "x402_settle",
      source_account_id: "acct_wallet",
      destination_counterparty_id: "cp_payee",
      amount: "10.00",
      currency: "USDC",
      pay_to: PAYEE,
    });
  });

  it("fails closed when the permission does not authorize the settlement (over allowance)", async () => {
    await expect(
      resolveSpendPermissionSettlement(makeDeps(), ctx, {
        permission: permission({ allowance: "5.00" }),
        amount: "10.00",
      }),
    ).rejects.toMatchObject({ code: "open_ecosystem_invalid_permission" });
  });

  it("fails closed when the token is not the configured USDC address", async () => {
    await expect(
      resolveSpendPermissionSettlement(makeDeps({ usdcAddress: "0x" + "99".repeat(20) }), ctx, {
        permission: permission(),
        amount: "10.00",
      }),
    ).rejects.toMatchObject({ code: "open_ecosystem_invalid_permission" });
  });

  it("fails closed when the payee spender is not a registered counterparty", async () => {
    await expect(
      resolveSpendPermissionSettlement(
        makeDeps({ resolvePayeeCounterparty: async () => null }),
        ctx,
        {
          permission: permission(),
          amount: "10.00",
        },
      ),
    ).rejects.toMatchObject({ code: "open_ecosystem_unknown_payee" });
  });

  it("fails closed when the smart wallet has no Brain source account", async () => {
    await expect(
      resolveSpendPermissionSettlement(makeDeps({ resolveWalletAccount: async () => null }), ctx, {
        permission: permission(),
        amount: "10.00",
      }),
    ).rejects.toMatchObject({ code: "open_ecosystem_unknown_wallet" });
  });

  it("throws a BrainError (typed envelope) on every failure", async () => {
    const err = await resolveSpendPermissionSettlement(makeDeps(), ctx, {
      permission: permission({ end: 100 }), // expired relative to now=50_000
      amount: "10.00",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BrainError);
    expect(err.code).toBe("open_ecosystem_invalid_permission");
  });
});
