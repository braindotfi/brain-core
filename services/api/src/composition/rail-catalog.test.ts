import { describe, expect, it } from "vitest";
import type { BrainConfig } from "@brain/shared";
import {
  RAIL_CATALOG,
  computeRailPostures,
  type RailDescriptor,
  type RailName,
} from "./rail-catalog.js";

/**
 * Minimal BrainConfig fixture. Only fields the rail catalog consults are
 * set; everything else defaults to undefined / sensible blanks. We cast
 * once at the boundary so tests don't depend on the full BrainConfig shape.
 */
function cfg(over: Partial<BrainConfig> = {}): BrainConfig {
  return {
    NODE_ENV: "test",
    BRAIN_BASE_CHAIN_ID: 84_532,
    BRAIN_ESCROW_AUDIT_APPROVED: "false",
    ...over,
  } as BrainConfig;
}

function setOf(...names: RailName[]): ReadonlySet<RailName> {
  return new Set(names);
}

describe("RAIL_CATALOG", () => {
  it("declares the five canonical rail names exactly once each", () => {
    const names = RAIL_CATALOG.map((d) => d.name).sort();
    expect(names).toEqual([
      "bank_ach",
      "erp_writeback",
      "escrow_base",
      "onchain_base",
      "x402_base",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks erp_writeback as the only non-production-allowed rail", () => {
    const nonProd = RAIL_CATALOG.filter((d) => !d.productionAllowed).map((d) => d.name);
    expect(nonProd).toEqual(["erp_writeback"]);
  });

  it("marks escrow_base as the only audit-required rail", () => {
    const audit = RAIL_CATALOG.filter((d) => d.auditRequired).map((d) => d.name);
    expect(audit).toEqual(["escrow_base"]);
  });
});

describe("computeRailPostures", () => {
  it("flags requiredEnvPresent only when every required env is set", () => {
    const partial = cfg({ PLAID_CLIENT_ID: "id" });
    const full = cfg({ PLAID_CLIENT_ID: "id", PLAID_SECRET: "sec" });
    const ach = (c: BrainConfig) =>
      computeRailPostures(RAIL_CATALOG, c, setOf()).find((p) => p.name === "bank_ach")!;
    expect(ach(partial).requiredEnvPresent).toBe(false);
    expect(ach(full).requiredEnvPresent).toBe(true);
  });

  it("erp_writeback always reports requiredEnvPresent=false (catalog has no env to check)", () => {
    // erp_writeback has requiredEnv: []. The natural .every() return of true
    // would lie ("env present" when there is no env). We defensively flip it
    // to false so the rails-matrix doesn't report a stub as ready.
    const erp = computeRailPostures(RAIL_CATALOG, cfg(), setOf()).find(
      (p) => p.name === "erp_writeback",
    )!;
    expect(erp.requiredEnvPresent).toBe(false);
    expect(erp.productionAllowed).toBe(false);
  });

  it("threads chainId through for EVM rails, null otherwise", () => {
    const out = computeRailPostures(RAIL_CATALOG, cfg({ BRAIN_BASE_CHAIN_ID: 8453 }), setOf());
    const byName = Object.fromEntries(out.map((p) => [p.name, p]));
    expect(byName.bank_ach!.chainId).toBeNull();
    expect(byName.erp_writeback!.chainId).toBeNull();
    expect(byName.onchain_base!.chainId).toBe(8453);
    expect(byName.x402_base!.chainId).toBe(8453);
    expect(byName.escrow_base!.chainId).toBe(8453);
  });

  it("escrow_base audit state: pending by default, approved when flag flipped, not_applicable for others", () => {
    const pending = computeRailPostures(RAIL_CATALOG, cfg(), setOf());
    const approved = computeRailPostures(
      RAIL_CATALOG,
      cfg({ BRAIN_ESCROW_AUDIT_APPROVED: "true" }),
      setOf(),
    );
    expect(pending.find((p) => p.name === "escrow_base")!.auditApproved).toBe("pending");
    expect(approved.find((p) => p.name === "escrow_base")!.auditApproved).toBe("approved");
    for (const p of pending) {
      if (p.name !== "escrow_base") {
        expect(p.auditApproved).toBe("not_applicable");
      }
    }
  });

  it("reports live=true only for rails the boot path actually registered", () => {
    const out = computeRailPostures(RAIL_CATALOG, cfg(), setOf("bank_ach", "onchain_base"));
    expect(out.find((p) => p.name === "bank_ach")!.live).toBe(true);
    expect(out.find((p) => p.name === "onchain_base")!.live).toBe(true);
    expect(out.find((p) => p.name === "x402_base")!.live).toBe(false);
    expect(out.find((p) => p.name === "escrow_base")!.live).toBe(false);
    expect(out.find((p) => p.name === "erp_writeback")!.live).toBe(false);
  });

  it("separates 'env set but rail not live' from 'env missing'", () => {
    // If env is wired but main.ts didn't push the rail into liveNames (e.g.
    // executor construction failed), posture should surface envPresent=true
    // + live=false so ops sees the mismatch.
    const c = cfg({
      BRAIN_X402_FACILITATOR_URL: "https://x402.test",
      BRAIN_X402_USDC_ADDRESS: "0x" + "ab".repeat(20),
      BRAIN_SESSION_KEY: "0x" + "cd".repeat(32),
      BASE_RPC_URL: "https://rpc.test",
    });
    const x402 = computeRailPostures(RAIL_CATALOG, c, setOf()).find((p) => p.name === "x402_base")!;
    expect(x402.requiredEnvPresent).toBe(true);
    expect(x402.live).toBe(false);
  });

  it("accepts a custom catalog (so tests can pin a subset without touching production data)", () => {
    const tiny: RailDescriptor[] = [
      {
        name: "bank_ach",
        description: "fixture",
        productionAllowed: true,
        requiredEnv: ["PLAID_CLIENT_ID"],
        evmChain: false,
        auditRequired: false,
      },
    ];
    const out = computeRailPostures(tiny, cfg({ PLAID_CLIENT_ID: "x" }), setOf("bank_ach"));
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("bank_ach");
    expect(out[0]!.live).toBe(true);
  });
});
