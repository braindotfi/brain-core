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

/**
 * Fail-closed guard. These stub rails return fabricated receipts (`stub: true`)
 * and move no real money, so a production deployment wired with them would
 * record fake settlements as completed executions. They must never run in
 * production. Mirrors the boot-time fences in services/api/src/main.ts
 * (BRAIN_DEMO_MODE / BRAIN_MCP_DEV_AUTH_BYPASS / BLOB_BACKEND=memory). Real
 * ACH / ERP / on-chain rails are a post-stage-6 deliverable.
 */
function assertStubRailsAllowed(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "stub payment rails cannot settle money in NODE_ENV=production; configure real ACH/ERP/on-chain rails before deploying",
    );
  }
}

export class BankAchRail implements Rail {
  public readonly kind = "bank_ach" as const;
  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    assertStubRailsAllowed();
    // TODO: wire Plaid Transfer via @brain/raw's Plaid SDK dep. The sandbox
    // integration tests exercise this path when PLAID_SANDBOX_KEY is set.
    // Returns a typed receipt (2.4) — wire vs ACH per the action.
    if (input.action.kind === "wire") {
      return {
        receipt: {
          rail: "wire",
          omad: `stub-omad-${input.executionId}`,
          imad: `stub-imad-${input.executionId}`,
          stub: true,
        },
      };
    }
    return {
      receipt: { rail: "ach", ach_trace: `stub-trace-${input.executionId}`, stub: true },
    };
  }
}

export class ErpWritebackRail implements Rail {
  public readonly kind = "erp_writeback" as const;
  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    assertStubRailsAllowed();
    return {
      receipt: { rail: "erp", erp_record_id: `stub-erp-${input.executionId}`, stub: true },
    };
  }
}

export class OnchainBaseRail implements Rail {
  public readonly kind = "onchain_base" as const;
  public async dispatch(input: RailDispatchInput): Promise<RailDispatchResult> {
    assertStubRailsAllowed();
    // Expected wire to BrainSmartAccount.executeViaSessionKey via viem.
    // Requires tenant's smart-account address + active session key.
    return {
      receipt: {
        rail: "onchain",
        tx_hash: `0xstub${input.executionId}`,
        block_number: 0,
        stub: true,
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
  assertStubRailsAllowed();
  return new RailRegistry([new BankAchRail(), new ErpWritebackRail(), new OnchainBaseRail()]);
}
