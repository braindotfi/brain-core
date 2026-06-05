/**
 * Production fence for the always-applicable money-path safety loaders.
 *
 * The §6 gate degrades a check to `not_applicable` when its loader is absent,
 * which is correct for action-type-specific loaders (escrow-state 6.6, M2M
 * attestation 5.5, x402 6.5, micropayment 8.5) that only apply when that rail
 * or action type is enabled. But three loaders apply to EVERY payment and must
 * never be silently absent in production:
 *   - resolveEvidence              (§6 check 9.5, evidence-semantic validation)
 *   - detectDuplicates             (§6 check 11.5, duplicate-payment rejection)
 *   - resolveObligationConfidence  (RFC 0004 §5.2, caps intent confidence at the
 *                                   obligation it pays so document-extracted
 *                                   evidence is gateable by policy)
 *   - resolveObligationDirection   (batch 10 H-1, §6 check 6.7, rejects outflows
 *                                   that target a receivable)
 *
 * Same fail-closed posture as the other boot fences (assertAtLeastOneLiveRail,
 * assertEscrowAuditApproved, assertDbIsolationFences):
 *   NODE_ENV=production + any missing → throw at boot (CrashLoopBackoff)
 *   dev/test                          → no-op
 *
 * This is a regression guard and an explicit production contract: today these
 * loaders are unconditionally built in main.ts, so the fence is a no-op on a
 * healthy boot, exactly like the rail fence is when a live rail is configured.
 * It bites if a future refactor makes one of them conditional. The
 * action-type-specific loaders are deliberately NOT required here — forcing
 * them would CrashLoop a valid ACH-only deployment.
 *
 * Factored out of main.ts so the behavior is unit-testable without booting.
 */

export interface PaymentLoadersProdFenceInput {
  nodeEnv: string | undefined;
  hasResolveEvidence: boolean;
  hasDetectDuplicates: boolean;
  hasResolveObligationConfidence: boolean;
  hasResolveObligationDirection: boolean;
}

/**
 * Throws when production booted without an always-applicable money-path loader.
 * No-op outside production or when all three are wired.
 */
export function assertMoneyPathLoadersWiredInProduction(input: PaymentLoadersProdFenceInput): void {
  if (input.nodeEnv !== "production") return;
  const missing: string[] = [];
  if (!input.hasResolveEvidence) missing.push("resolveEvidence (§6 check 9.5)");
  if (!input.hasDetectDuplicates) missing.push("detectDuplicates (§6 check 11.5)");
  if (!input.hasResolveObligationConfidence) {
    missing.push("resolveObligationConfidence (RFC 0004 §5.2)");
  }
  if (!input.hasResolveObligationDirection) {
    missing.push("resolveObligationDirection (§6 check 6.7, batch 10 H-1)");
  }
  if (missing.length === 0) return;
  throw new Error(
    "NODE_ENV=production requires the always-applicable money-path safety " +
      `loaders to be wired; missing: ${missing.join(", ")}. These gate every ` +
      "payment (evidence-semantic validation, duplicate-payment rejection, and " +
      "the obligation confidence cap); a missing loader would let the §6 gate " +
      "record not_applicable and pass vacuously. Refusing to start so the " +
      "orchestrator surfaces the misconfiguration as CrashLoopBackoff.",
  );
}
