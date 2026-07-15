export interface OutboxDispatchGuardFenceInput {
  nodeEnv: string;
  executionWorkerEnabled: boolean;
  beforeDispatchConfigured: boolean;
}

/**
 * Production execution workers must keep the final pre-dispatch guard wired.
 * The guard re-enters tenant scope and blocks dispatch when the originating
 * agent is missing, halted, or quarantined.
 */
export function assertOutboxDispatchGuardWiredInProduction(
  input: OutboxDispatchGuardFenceInput,
): void {
  if (input.nodeEnv !== "production") return;
  if (!input.executionWorkerEnabled) return;
  if (input.beforeDispatchConfigured) return;

  throw new Error(
    "production execution worker requires outbox beforeDispatch guard; refusing to boot",
  );
}
