/**
 * MVP rail implementations. §3 Layer 4 lists three first-class rails:
 *   bank_ach       — Plaid Transfer fallback where direct bank API unavailable
 *   erp_writeback  — NetSuite SuiteTalk write
 *   onchain_base   — BrainSmartAccount.executeViaSessionKey
 *
 * These stubs acknowledge dispatches and return a placeholder receipt.
 * Real rail implementations live in dedicated modules wiring Plaid SDK,
 * NetSuite OAuth client, and viem Base RPC respectively — each is a
 * focused PR post-stage-6.
 */

import { brainError } from "@brain/shared";
import type { Rail, RailDispatchInput, RailDispatchResult } from "./types.js";

export class BankAchRail implements Rail {
  public readonly kind = "bank_ach" as const;
  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    // TODO: wire Plaid Transfer via @brain/raw's Plaid SDK dep. The sandbox
    // integration tests exercise this path when PLAID_SANDBOX_KEY is set.
    return {
      receipt: {
        rail: "bank_ach",
        stub: true,
        acknowledged_at: new Date().toISOString(),
        proposal_id: input.proposalId,
        execution_id: input.executionId,
      },
    };
  }
}

export class ErpWritebackRail implements Rail {
  public readonly kind = "erp_writeback" as const;
  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    return {
      receipt: {
        rail: "erp_writeback",
        stub: true,
        acknowledged_at: new Date().toISOString(),
        execution_id: input.executionId,
      },
    };
  }
}

export class OnchainBaseRail implements Rail {
  public readonly kind = "onchain_base" as const;
  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    // Expected wire to BrainSmartAccount.executeViaSessionKey via viem.
    // Requires tenant's smart-account address + active session key.
    // The payment-agent orchestrator is responsible for calling this rail
    // only when the on-chain path is appropriate — we don't validate here.
    return {
      receipt: {
        rail: "onchain_base",
        stub: true,
        acknowledged_at: new Date().toISOString(),
        proposal_id: input.proposalId,
      },
    };
  }
}

/** Registry keyed by rail kind. Throws execution_rail_unavailable on miss. */
export class RailRegistry {
  private readonly byKind: Map<string, Rail>;
  public constructor(rails: ReadonlyArray<Rail>) {
    this.byKind = new Map(rails.map((r) => [r.kind, r]));
  }
  public get(kind: string): Rail {
    const r = this.byKind.get(kind);
    if (r === undefined) {
      throw brainError("execution_rail_unavailable", `rail not configured: ${kind}`);
    }
    return r;
  }
}

export function defaultRails(): RailRegistry {
  return new RailRegistry([new BankAchRail(), new ErpWritebackRail(), new OnchainBaseRail()]);
}
