/**
 * Spec-first stub for the Phase-2 `x402_settle` action type (RFC 0001 §6–§7.3).
 *
 * The OpenAPI contract already lists `x402_settle` (marked planned). These
 * `todo`s pin the behavior the implementation must satisfy as the x402 path
 * lands — every item flows through the SAME PaymentIntent → §6 gate → audit
 * path; there is no separate un-gated commerce path.
 *
 *   2C-A — `x402_settle` is a creatable, §6-gated action type (USDC accepted).
 *   2C-B — the settlement context (asset/network/amount/recipient) is carried
 *          onto the gate intent, activating the deterministic §6 payment-context
 *          check (gate check 6.5, RFC §6.1). The check logic itself is proven in
 *          shared/src/gate/gate.x402.test.ts.
 *   2C-C — the gate loaders (attestation, window-spend, policy dimensions)
 *          activate checks 3.5 / 5.5 / 8.5.
 *
 * Still shadow-first: nothing settles until the commerce agent is in LIVE_AGENTS
 * and an `x402_base` rail is registered at boot (`RailRegistry` fails closed).
 */

import { describe, expect, it } from "vitest";
import { isAcceptedActionType, isValidCurrency } from "./routes.js";
import { gateSettlement } from "./PaymentIntentService.js";

const PAY_TO = "0x" + "ab".repeat(20);

describe("x402_settle (RFC 0001) — 2C-A: action type + currency", () => {
  it("accepts `x402_settle` as a create action type", () => {
    expect(isAcceptedActionType("x402_settle")).toBe(true);
    // canonical rails still accepted; an unknown type still rejected.
    expect(isAcceptedActionType("ach_outbound")).toBe(true);
    expect(isAcceptedActionType("definitely_not_a_rail")).toBe(false);
    expect(isAcceptedActionType(undefined)).toBe(false);
  });

  it("accepts USDC only for x402_settle; fiat rails stay ISO-4217 3-letter", () => {
    expect(isValidCurrency("x402_settle", "USDC")).toBe(true);
    // x402 is USDC-only (D-4): a 3-letter fiat code is not a valid x402 currency.
    expect(isValidCurrency("x402_settle", "USD")).toBe(false);
    // fiat rails: 3-letter ISO only — USDC (4 chars) is rejected for them.
    expect(isValidCurrency("ach_outbound", "USD")).toBe(true);
    expect(isValidCurrency("ach_outbound", "USDC")).toBe(false);
    expect(isValidCurrency("wire", "eur")).toBe(false);
  });
});

describe("x402_settle (RFC 0001) — 2C-B: settlement-context carriage (activates gate 6.5)", () => {
  it("builds the on-chain settlement context for an x402_settle intent", () => {
    // The settled asset IS the intent currency (USDC) on Base; the gate (6.5)
    // re-validates these fields against the resolved counterparty.
    expect(gateSettlement("x402_settle", "USDC", "12.50", PAY_TO)).toEqual({
      settlement: { asset: "USDC", network: "base", amount: "12.50", pay_to: PAY_TO },
    });
  });

  it("carries no settlement context for non-x402 actions (canonical path preserved)", () => {
    expect(gateSettlement("ach_outbound", "USD", "12.50", PAY_TO)).toEqual({});
  });

  it("carries no settlement context when the x402 recipient is absent (gate stays dormant)", () => {
    expect(gateSettlement("x402_settle", "USDC", "12.50", null)).toEqual({});
    expect(gateSettlement("x402_settle", "USDC", "12.50", undefined)).toEqual({});
  });

  // The gate check that consumes this context (6.5 — USDC/Base/amount/recipient)
  // is proven in shared/src/gate/gate.x402.test.ts.
  it.todo("resolves an x402 payment request to { source, agent counterparty, amount, USDC }");
  // 2C-C — the gate loaders activate these.
  it.todo("gate check: on-chain settlement is permitted for this payment class (RFC §6.5)");
  it.todo("gate check: agent-counterparty is registered + attested + not paused (RFC §6.3)");
  it.todo("gate check: micropayment cumulative cap within the policy envelope (RFC §6.4)");
  // Phase 3+ — live rail wiring.
  it.todo("settles USDC on Base via X402BaseRail; dispatched → settled on confirmation");
  it.todo("emits the same audit events as any other settlement (Merkle-anchored)");
  it.todo("fails closed under NODE_ENV=production when the x402 client is unconfigured");
});
