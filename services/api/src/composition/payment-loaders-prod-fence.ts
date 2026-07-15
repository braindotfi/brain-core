/**
 * Production fence for the always-applicable money-path safety loaders.
 *
 * The §6 gate degrades a check to `not_applicable` when its loader is absent,
 * which is correct for truly rail-specific loaders (escrow-state 6.6, x402 6.5)
 * that only apply when that rail or action type is enabled. But several
 * loaders either apply to every payment or are built unconditionally in the
 * production composition root and must never be silently absent in production:
 *   - resolveTenantFlags          (§6 check 1.5, behavior-hash pinning)
 *   - resolveEvidence              (§6 check 9.5, evidence-semantic validation)
 *   - detectDuplicates             (§6 check 11.5, duplicate-payment rejection)
 *   - sumActiveReservations        (§6 check 8, available_balance >= amount + reserved;
 *                                   without it the gate falls back to reserved="0" and
 *                                   the parallel double-spend window opens silently --
 *                                   batch 11 M-1 closes this seam)
 *   - attestCounterpartyAgent      (§6 check 5.5, M2M agent-payee attestation)
 *   - sumAgentWindowSpend          (§6 check 8.5, micropayment rolling-window cap)
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
 * rail-specific loaders are deliberately NOT required here. Forcing them would
 * CrashLoop a valid ACH-only deployment.
 *
 * Factored out of main.ts so the behavior is unit-testable without booting.
 */

export interface PaymentLoadersProdFenceInput {
  nodeEnv: string | undefined;
  hasResolveTenantFlags: boolean;
  hasResolveEvidence: boolean;
  hasDetectDuplicates: boolean;
  hasSumActiveReservations: boolean;
  hasAttestCounterpartyAgent: boolean;
  hasSumAgentWindowSpend: boolean;
  hasResolveObligationConfidence: boolean;
  hasResolveObligationDirection: boolean;
}

/**
 * Throws when production booted without an always-applicable money-path loader.
 * No-op outside production or when all loaders are wired.
 */
export function assertMoneyPathLoadersWiredInProduction(input: PaymentLoadersProdFenceInput): void {
  if (input.nodeEnv !== "production") return;
  const missing: string[] = [];
  if (!input.hasResolveTenantFlags) {
    missing.push("resolveTenantFlags (§6 check 1.5)");
  }
  if (!input.hasResolveEvidence) missing.push("resolveEvidence (§6 check 9.5)");
  if (!input.hasDetectDuplicates) missing.push("detectDuplicates (§6 check 11.5)");
  if (!input.hasSumActiveReservations) {
    missing.push("sumActiveReservations (§6 check 8, batch 11 M-1)");
  }
  if (!input.hasAttestCounterpartyAgent) {
    missing.push("attestCounterpartyAgent (§6 check 5.5)");
  }
  if (!input.hasSumAgentWindowSpend) {
    missing.push("sumAgentWindowSpend (§6 check 8.5)");
  }
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
      "payment (behavior-hash pinning, evidence-semantic validation, " +
      "duplicate-payment rejection, concurrent-reservation accounting, M2M " +
      "agent-payee attestation, micropayment window spending, the obligation " +
      "confidence cap, and the outflow-receivable rejection); a missing loader " +
      "would let the §6 gate record not_applicable and pass vacuously. Refusing " +
      "to start so the orchestrator surfaces the misconfiguration as " +
      "CrashLoopBackoff.",
  );
}
