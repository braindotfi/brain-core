/**
 * Production fence for the rail-registry fallback path.
 *
 * When no live rail (`bank_ach` / `onchain_base` / `x402_base` / `escrow_base`)
 * is configured, the boot path historically fell through to `defaultRails()`
 * (dev stubs) with only a `log.warn`. The stubs themselves fail closed at
 * dispatch in production (post-review item 20), but that is a runtime catch on
 * the first payment attempt, not a boot fence — orchestrators don't surface
 * "100% of payments are 500-ing" as quickly as they surface CrashLoopBackoff.
 *
 * Same posture as the other fail-closed fences (assertDbIsolationFences,
 * assertEscrowAuditApproved, BRAIN_AGENTS_INBOUND_SECRET, AES-GCM key):
 *   NODE_ENV=production + no live rail → throw at boot
 *   dev/test                            → warn and continue (stubs are fine)
 *
 * Factored out of main.ts so the behavior is unit-testable without booting
 * the full server.
 */

export interface RailsProdFenceInput {
  nodeEnv: string | undefined;
  /** Count of live rails the boot path was able to register. */
  liveRailCount: number;
}

/**
 * Throws when production booted with zero live rails. No-op otherwise — the
 * caller still emits its own info/warn log.
 */
export function assertAtLeastOneLiveRailInProduction(input: RailsProdFenceInput): void {
  if (input.nodeEnv !== "production") return;
  if (input.liveRailCount > 0) return;
  throw new Error(
    "No live payment rails configured in NODE_ENV=production. At least one of " +
      "PLAID_CLIENT_ID+PLAID_SECRET (bank_ach), BRAIN_SESSION_KEY+BASE_RPC_URL " +
      "(onchain_base), BRAIN_X402_FACILITATOR_URL+BRAIN_X402_USDC_ADDRESS " +
      "(x402_base), or BRAIN_ESCROW_ADDRESS+BRAIN_ONCHAIN_SMART_ACCOUNT " +
      "(escrow_base) must be set. The dev-stub fallback fails closed at " +
      "dispatch but lets the api boot; refusing to start so the orchestrator " +
      "surfaces the misconfiguration as CrashLoopBackoff.",
  );
}
