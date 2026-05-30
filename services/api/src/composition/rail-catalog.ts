/**
 * Per-rail static metadata + posture computation.
 *
 * Single source of truth for "what rails does Brain ship and what's their
 * production posture?" Read by:
 *   - capabilities.ts / main.ts → brain.runtime.capabilities log line
 *   - docs/rails-matrix.md      → release-manager support table
 *
 * The catalog is intentionally STATIC (no env reads at module scope). The
 * `posture(catalog, cfg)` function is the only place env is consulted, so the
 * catalog is trivially serializable for docs generation and the runtime
 * read is deterministic at boot.
 */
import type { BrainConfig } from "@brain/shared";

/** The canonical rail key set Brain ships with. */
export type RailName =
  | "bank_ach"
  | "onchain_base"
  | "x402_base"
  | "escrow_base"
  | "erp_writeback";

export interface RailDescriptor {
  name: RailName;
  /** Human-readable summary for the rails-matrix doc. */
  description: string;
  /**
   * True if this rail has a real production implementation. The `*StubRail`
   * fail-closed-in-prod set (item 20) lives outside this catalog; only rails
   * with a real client/executor are flagged production-allowed.
   *
   * `erp_writeback` is the one stub-only entry: no production implementation
   * exists yet, so production_allowed=false even when it's registered.
   */
  productionAllowed: boolean;
  /** Env vars required for the rail to register at boot. */
  requiredEnv: ReadonlyArray<keyof BrainConfig>;
  /**
   * Whether this rail dispatches against an EVM chain. Non-EVM rails
   * (bank_ach, erp_writeback) record chainId=null in the posture.
   */
  evmChain: boolean;
  /**
   * Whether this rail's smart-contract surface requires the external audit
   * before mainnet boot. Today only `escrow_base` (BrainEscrow) is gated;
   * the others use audited primitives or are off-chain entirely.
   */
  auditRequired: boolean;
}

export const RAIL_CATALOG: ReadonlyArray<RailDescriptor> = [
  {
    name: "bank_ach",
    description: "ACH via Plaid Transfer. Fiat USD, sandbox + production.",
    productionAllowed: true,
    requiredEnv: ["PLAID_CLIENT_ID", "PLAID_SECRET"],
    evmChain: false,
    auditRequired: false,
  },
  {
    name: "onchain_base",
    description: "ERC-20 transfer on Base via BrainSmartAccount session key.",
    productionAllowed: true,
    requiredEnv: ["BRAIN_SESSION_KEY", "BASE_RPC_URL"],
    evmChain: true,
    auditRequired: false,
  },
  {
    name: "x402_base",
    description: "Per-call USDC settlement via Coinbase x402 facilitator.",
    productionAllowed: true,
    requiredEnv: [
      "BRAIN_X402_FACILITATOR_URL",
      "BRAIN_X402_USDC_ADDRESS",
      "BRAIN_SESSION_KEY",
      "BASE_RPC_URL",
    ],
    evmChain: true,
    auditRequired: false,
  },
  {
    name: "escrow_base",
    description:
      "Conditional USDC release via BrainEscrow (RFC 0001 §7.6). Mainnet blocked on external audit.",
    productionAllowed: true,
    requiredEnv: [
      "BRAIN_ESCROW_ADDRESS",
      "BRAIN_ONCHAIN_SMART_ACCOUNT",
      "BRAIN_SESSION_KEY",
      "BASE_RPC_URL",
    ],
    evmChain: true,
    auditRequired: true,
  },
  {
    name: "erp_writeback",
    description:
      "ERP system-of-record writeback. Stub-only in MVP; no production implementation.",
    productionAllowed: false,
    requiredEnv: [],
    evmChain: false,
    auditRequired: false,
  },
];

export type AuditApprovalState = "approved" | "pending" | "not_applicable";

export interface RailPosture {
  name: RailName;
  /** Real client/executor wired (not the *StubRail dev fallback). */
  live: boolean;
  /** This rail has a real production implementation at all. */
  productionAllowed: boolean;
  /** Every required env var is set; the rail would actually register at boot. */
  requiredEnvPresent: boolean;
  /** EVM chain id this rail dispatches against, or null for non-EVM rails. */
  chainId: number | null;
  /** Whether external audit is required before mainnet boot. */
  auditRequired: boolean;
  /**
   * Audit approval state derived from BRAIN_ESCROW_AUDIT_APPROVED + chain.
   *   approved        — auditRequired AND approval flag explicitly true.
   *   pending         — auditRequired AND approval not yet flipped.
   *   not_applicable  — auditRequired=false (no audit needed for this rail).
   */
  auditApproved: AuditApprovalState;
}

/**
 * Compute per-rail production posture from the static catalog plus the
 * boot config. Pure (no env reads beyond the supplied cfg) and deterministic
 * so the same cfg always produces the same posture.
 *
 * Inputs:
 *   catalog      RAIL_CATALOG (or a test override).
 *   cfg          the loaded BrainConfig.
 *   liveNames    set of rail keys the boot path successfully registered with
 *                a real client/executor (RailRegistry.entries.live=true).
 *
 * The split between "requiredEnvPresent" and "live" lets ops distinguish
 * "env is set but the rail failed to construct" from "env is missing."
 */
export function computeRailPostures(
  catalog: ReadonlyArray<RailDescriptor>,
  cfg: BrainConfig,
  liveNames: ReadonlySet<RailName>,
): ReadonlyArray<RailPosture> {
  return catalog.map((d) => {
    const requiredEnvPresent =
      d.requiredEnv.length === 0
        ? false
        : d.requiredEnv.every((k) => {
            const v = cfg[k];
            return v !== undefined && v !== "";
          });
    const chainId: number | null = d.evmChain ? cfg.BRAIN_BASE_CHAIN_ID : null;
    const auditApproved: AuditApprovalState = !d.auditRequired
      ? "not_applicable"
      : cfg.BRAIN_ESCROW_AUDIT_APPROVED === "true"
        ? "approved"
        : "pending";
    return {
      name: d.name,
      live: liveNames.has(d.name),
      productionAllowed: d.productionAllowed,
      requiredEnvPresent,
      chainId,
      auditRequired: d.auditRequired,
      auditApproved,
    };
  });
}
