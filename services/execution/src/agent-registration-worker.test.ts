import { describe, expect, it, vi } from "vitest";
import type { ServiceCallContext } from "@brain/shared";
import {
  AGENT_ATTESTATION_MAX_ATTEMPTS,
  runAgentRegistrationCycle,
  type AgentRegistrationWorkerDeps,
} from "./agent-registration-worker.js";
import { InsufficientRelayerFundsError } from "./relayers/kms-custodial.js";
import type { PrivilegedAgentClient } from "./repository.js";
import type { AgentRecord } from "@brain/shared";

const FAKE_CONFIRMED: AgentRecord = {
  id: "agent_a",
  kind: "external",
  role: "anomaly",
  display_name: "test",
  scope_hash: null,
  onchain_address: null,
  state: "active",
  registered_tx: "0xtx",
  registered_at: new Date().toISOString(),
};

interface Row {
  id: string;
  tenant_id: string;
  onchain_attestation_attempts: number;
}

/**
 * One fake privileged connection shared by every `withPrivileged` call in a
 * cycle, dispatching on a SQL substring the way the AgentService fixtures
 * elsewhere in this package do. `rows` is returned exactly once (the claim
 * query); every later call in the same cycle sees an empty claim.
 */
function makeDeps(
  rows: Row[],
  confirmImpl: (ctx: ServiceCallContext, agentId: string) => Promise<AgentRecord>,
): {
  deps: AgentRegistrationWorkerDeps;
  calls: { resetLease: string[]; markFailed: string[]; markAttestationFailed: string[] };
} {
  const calls = {
    resetLease: [] as string[],
    markFailed: [] as string[],
    markAttestationFailed: [] as string[],
  };
  let claimed = false;

  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("SELECT id FROM agents")) {
      if (claimed) return { rows: [], rowCount: 0 };
      claimed = true;
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("next_attempt_at = NULL")) {
      calls.resetLease.push(values[0] as string);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("onchain_attestation_attempts = onchain_attestation_attempts + 1")) {
      const id = values[0] as string;
      calls.markAttestationFailed.push(id);
      const row = rows.find((r) => r.id === id);
      const next = (row?.onchain_attestation_attempts ?? 0) + 1;
      return { rows: [{ onchain_attestation_attempts: next }], rowCount: 1 };
    }
    if (sql.includes("state = 'failed'")) {
      calls.markFailed.push(values[0] as string);
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query } as unknown as PrivilegedAgentClient;

  const deps: AgentRegistrationWorkerDeps = {
    agentService: { confirmRegistration: vi.fn(confirmImpl) },
    withPrivileged: async (fn) => fn(client),
  };
  return { deps, calls };
}

describe("runAgentRegistrationCycle", () => {
  it("confirms every claimed row and tallies confirmed", async () => {
    const rows: Row[] = [
      { id: "agent_a", tenant_id: "tnt_a", onchain_attestation_attempts: 0 },
      { id: "agent_b", tenant_id: "tnt_b", onchain_attestation_attempts: 0 },
    ];
    const { deps } = makeDeps(rows, async () => FAKE_CONFIRMED);

    const result = await runAgentRegistrationCycle(deps);

    expect(result).toEqual({
      claimed: 2,
      confirmed: 2,
      insufficientFunds: 0,
      retrying: 0,
      failed: 0,
    });
  });

  it("insufficient funds releases the lease, does not consume an attempt, and does not fail the agent", async () => {
    const rows: Row[] = [{ id: "agent_a", tenant_id: "tnt_a", onchain_attestation_attempts: 3 }];
    const { deps, calls } = makeDeps(rows, async () => {
      throw new InsufficientRelayerFundsError(1n, 1_000_000n);
    });

    const result = await runAgentRegistrationCycle(deps);

    expect(result.insufficientFunds).toBe(1);
    expect(result.retrying).toBe(0);
    expect(result.failed).toBe(0);
    expect(calls.resetLease).toEqual(["agent_a"]);
    expect(calls.markAttestationFailed).toEqual([]);
    expect(calls.markFailed).toEqual([]);
  });

  it("a mined-revert failure bumps the backoff and retries when under the ceiling", async () => {
    const rows: Row[] = [{ id: "agent_a", tenant_id: "tnt_a", onchain_attestation_attempts: 0 }];
    const { deps, calls } = makeDeps(rows, async () => {
      throw new Error("registerAgent reverted (tx 0xdead)");
    });

    const result = await runAgentRegistrationCycle(deps);

    expect(result.retrying).toBe(1);
    expect(result.failed).toBe(0);
    expect(calls.markAttestationFailed).toEqual(["agent_a"]);
    expect(calls.markFailed).toEqual([]);
  });

  it("marks the agent failed once the attempt ceiling is reached", async () => {
    const rows: Row[] = [
      {
        id: "agent_a",
        tenant_id: "tnt_a",
        onchain_attestation_attempts: AGENT_ATTESTATION_MAX_ATTEMPTS - 1,
      },
    ];
    const { deps, calls } = makeDeps(rows, async () => {
      throw new Error("registerAgent reverted (tx 0xdead)");
    });

    const result = await runAgentRegistrationCycle(deps);

    expect(result.failed).toBe(1);
    expect(result.retrying).toBe(0);
    expect(calls.markFailed).toEqual(["agent_a"]);
  });

  it("a recovered crashed-retry (confirmRegistration resolves with no txHash) counts as confirmed, not a failure", async () => {
    const rows: Row[] = [{ id: "agent_a", tenant_id: "tnt_a", onchain_attestation_attempts: 3 }];
    const { deps, calls } = makeDeps(rows, async () => ({
      ...FAKE_CONFIRMED,
      state: "active",
      registered_tx: null,
    }));

    const result = await runAgentRegistrationCycle(deps);

    expect(result.confirmed).toBe(1);
    expect(result.retrying).toBe(0);
    expect(result.failed).toBe(0);
    expect(calls.markAttestationFailed).toEqual([]);
    expect(calls.markFailed).toEqual([]);
  });

  it("isolates a poison row so one failure does not abort the rest of the batch", async () => {
    const rows: Row[] = [
      { id: "agent_poison", tenant_id: "tnt_a", onchain_attestation_attempts: 0 },
      { id: "agent_ok", tenant_id: "tnt_b", onchain_attestation_attempts: 0 },
    ];
    const { deps } = makeDeps(rows, async (_ctx, agentId) => {
      if (agentId === "agent_poison") throw new Error("boom");
      return FAKE_CONFIRMED;
    });

    const result = await runAgentRegistrationCycle(deps);

    expect(result.claimed).toBe(2);
    expect(result.confirmed).toBe(1);
    expect(result.retrying).toBe(1);
  });
});
