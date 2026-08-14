/**
 * Agent on-chain registration worker -- RFC 0002 Phase C, increment 3.
 *
 * AgentService.confirmRegistration was written (increment 2) but called from
 * nowhere: nothing ever promoted a `pending_onchain` agent to `active`. This
 * is the async driver. It claims `pending_onchain` agents cross-tenant
 * (batched, oldest-first, leased via `next_attempt_at` so a crashed worker's
 * claim self-heals once the lease expires -- see
 * repository.claimPendingOnchainAgentsForAttestation) and calls
 * confirmRegistration per row, isolating one row's failure from the rest of
 * the batch (mirrors the wiki regeneration worker's per-slug isolation and
 * the execution outbox worker's per-row bounded backoff).
 *
 * Insufficient relayer funds is never a permanent failure (matches
 * InsufficientAnchorFundsError's posture in anchorBroadcaster.ts): the claim
 * lease is released immediately, no attempt is consumed, and the row is
 * retried next cycle. Any other failure (a mined revert, a transient RPC
 * error) bumps the bounded exponential backoff and, at the attempt ceiling,
 * terminally fails the row.
 */

import {
  startManagedInterval,
  type ManagedWorker,
  type MetricsEmitter,
  type ServiceCallContext,
} from "@brain/shared";
import { InsufficientRelayerFundsError } from "./relayers/kms-custodial.js";
import {
  claimPendingOnchainAgentsForAttestation,
  markAgentAttestationFailed,
  markAgentFailed,
  resetAgentAttestationLease,
  type PrivilegedAgentClient,
} from "./repository.js";
import type { AgentService } from "./AgentService.js";

export const DEFAULT_AGENT_REGISTRATION_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 20;
/** Same ceiling as MAX_TOTAL_DISPATCH_ATTEMPTS (OutboxService): with the same
 *  30s/2x/480s-cap backoff schedule, the ceiling is reached after roughly
 *  1.5 hours of slowing retries. */
export const AGENT_ATTESTATION_MAX_ATTEMPTS = 12;
const WORKER_ACTOR = "system:agent-registration-worker";

export interface AgentRegistrationWorkerDeps {
  agentService: Pick<AgentService, "confirmRegistration">;
  /** Runs `fn` on a privileged (cross-tenant, brain_execution_worker) connection. */
  withPrivileged: <T>(fn: (client: PrivilegedAgentClient) => Promise<T>) => Promise<T>;
  metrics?: MetricsEmitter;
  log?: {
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
  };
}

export interface AgentRegistrationCycleResult {
  claimed: number;
  confirmed: number;
  insufficientFunds: number;
  retrying: number;
  failed: number;
}

/** Same schedule as OutboxService.RETRY_BACKOFF_*: 30s, 60s, 120s, 240s, capped at 480s. */
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 480;

export function startAgentRegistrationWorker(
  deps: AgentRegistrationWorkerDeps,
  opts: { intervalMs?: number; limit?: number } = {},
): ManagedWorker {
  const intervalMs = opts.intervalMs ?? DEFAULT_AGENT_REGISTRATION_INTERVAL_MS;
  return startManagedInterval(
    async () => {
      await runAgentRegistrationCycle(deps, opts);
    },
    intervalMs,
    {
      name: "agent-registration",
      onError: (err) => deps.log?.error({ err }, "agent registration cycle failed"),
    },
  );
}

export async function runAgentRegistrationCycle(
  deps: AgentRegistrationWorkerDeps,
  opts: { limit?: number } = {},
): Promise<AgentRegistrationCycleResult> {
  const limit = opts.limit ?? DEFAULT_BATCH_SIZE;
  const rows = await deps.withPrivileged((c) =>
    claimPendingOnchainAgentsForAttestation(c, limit, AGENT_ATTESTATION_MAX_ATTEMPTS),
  );

  const tally: AgentRegistrationCycleResult = {
    claimed: rows.length,
    confirmed: 0,
    insufficientFunds: 0,
    retrying: 0,
    failed: 0,
  };

  for (const row of rows) {
    const ctx: ServiceCallContext = { tenantId: row.tenant_id, actor: WORKER_ACTOR };
    try {
      await deps.agentService.confirmRegistration(ctx, row.id);
      tally.confirmed += 1;
    } catch (err) {
      if (err instanceof InsufficientRelayerFundsError) {
        await deps.withPrivileged((c) => resetAgentAttestationLease(c, row.id));
        deps.metrics?.increment("brain.agent_registration.insufficient_funds.count");
        tally.insufficientFunds += 1;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      const attempts = await deps.withPrivileged((c) =>
        markAgentAttestationFailed(c, row.id, message, BACKOFF_BASE_SECONDS, BACKOFF_CAP_SECONDS),
      );
      if (attempts >= AGENT_ATTESTATION_MAX_ATTEMPTS) {
        await deps.withPrivileged((c) => markAgentFailed(c, row.id, message));
        deps.metrics?.increment("brain.agent_registration.failed.count");
        deps.log?.warn(
          { agentId: row.id, tenantId: row.tenant_id, attempts, err: message },
          "agent on-chain attestation exhausted its attempt ceiling; agent marked failed",
        );
        tally.failed += 1;
        continue;
      }
      deps.metrics?.increment("brain.agent_registration.retrying.count");
      tally.retrying += 1;
    }
  }

  return tally;
}
