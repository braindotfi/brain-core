/**
 * PRODUCT DECISION: gate check 5.5 verifies the payee agent is genuinely
 * registered in `BrainMCPAgentRegistry` and not revoked, regardless of which
 * tenant registered it. `_agents` is a global namespace, and rejecting
 * tenant A paying tenant B's registered agent would hard-reject the
 * canonical cross-org M2M/x402 case the rail exists for
 * (docs/v0.4-open-ecosystem-interop.md §7). This loader reads `getAgent`
 * only and never calls `isAuthorized`, which additionally requires
 * `r.tenantId == tenantId`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { keccak256, toBytes } from "viem";
import type * as Viem from "viem";

const readContract = vi.fn();

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof Viem>("viem");
  return {
    ...actual,
    createPublicClient: () => ({ readContract }),
    http: () => undefined,
  };
});

const { makeAttestCounterpartyAgent } = await import("./agent-attestation.js");

const REGISTRY = "0x" + "aa".repeat(20);
// A realistic ULID, matching ledger_counterparties.agent_id's
// ^agent_[0-9A-HJKMNP-TV-Z]{26}$ constraint. Never a hex value — the loader
// must hash it before it reaches calldata (see agent-attestation.ts).
const AGENT_ID = "agent_01JABCDEFGHJKMNPQRSTVWXYZ0";
const AGENT_ID_B32 = keccak256(toBytes(AGENT_ID));
const TENANT_A = "tnt_00000000010000000000000000";
const TENANT_B = "tnt_00000000020000000000000000";

const ctx = {} as never;

function registration(overrides: Record<string, unknown> = {}) {
  return {
    agentId: AGENT_ID_B32,
    agentAddress: "0x" + "cc".repeat(20),
    tenantId: keccak256(toBytes(TENANT_A)),
    scopeHash: "0x" + "00".repeat(32),
    behaviorHash: "0x" + "00".repeat(32),
    registeredAt: 1n,
    revokedAt: 0n,
    ...overrides,
  };
}

function attest() {
  return makeAttestCounterpartyAgent({
    registryAddress: REGISTRY,
    rpcUrl: "http://localhost:8545",
  });
}

beforeEach(() => {
  readContract.mockReset();
});

describe("agent attestation, tenant-agnostic registration check", () => {
  it("reads getAgent with the keccak256 of the agent id, never isAuthorized", async () => {
    readContract.mockResolvedValue(registration());
    const result = await attest()(ctx, {
      tenantId: TENANT_A,
      counterpartyId: "cp_1",
      agentId: AGENT_ID,
    });

    expect(result.attested).toBe(true);
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "getAgent",
        // AGENT_ID is a ULID (ledger_counterparties.agent_id), never hex: it
        // must be keccak256-encoded before it reaches calldata. A bare
        // `as \`0x${string}\`` cast here spliced raw ASCII into calldata and
        // made every agent payee hard-reject.
        args: [AGENT_ID_B32],
      }),
    );
  });

  it("accepts an agent registered under a DIFFERENT tenant than the caller", async () => {
    // Registered by tenant A; the caller here is tenant B. Check 5.5 must
    // not reject this — it is the canonical cross-org M2M/x402 case.
    readContract.mockResolvedValue(registration());

    const result = await attest()(ctx, {
      tenantId: TENANT_B,
      counterpartyId: "cp_1",
      agentId: AGENT_ID,
    });

    expect(result.attested).toBe(true);
    expect(result.registered).toBe(true);
  });

  it("caches the verdict by agent id alone, so a different calling tenant hits the same entry", async () => {
    readContract.mockResolvedValue(registration());

    const resolve = attest();
    await resolve(ctx, { tenantId: TENANT_A, counterpartyId: "cp_1", agentId: AGENT_ID });
    const b = await resolve(ctx, { tenantId: TENANT_B, counterpartyId: "cp_1", agentId: AGENT_ID });

    expect(b.attested).toBe(true);
    // One registry read total: the second call (different tenant, same
    // agent) was served from cache, proving the key is agent-only.
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  it("reports a revoked agent as revoked, never as paused", async () => {
    readContract.mockResolvedValue(registration({ revokedAt: 99n }));

    const result = await attest()(ctx, {
      tenantId: TENANT_A,
      counterpartyId: "cp_1",
      agentId: AGENT_ID,
    });

    // Revocation is terminal in the registry: no unpause, and the agentId can
    // never be re-registered.
    expect(result.attested).toBe(false);
    expect(result.revoked).toBe(true);
    expect(result.reason).toBe("agent_revoked");
    expect(result.reason).not.toBe("agent_paused");
  });

  it("reports an unknown agent as not registered", async () => {
    readContract.mockResolvedValue(registration({ registeredAt: 0n }));

    const result = await attest()(ctx, {
      tenantId: TENANT_A,
      counterpartyId: "cp_1",
      agentId: AGENT_ID,
    });

    expect(result.attested).toBe(false);
    expect(result.registered).toBe(false);
    expect(result.reason).toBe("agent_not_registered");
  });

  it("fails closed when the registry read throws", async () => {
    readContract.mockRejectedValue(new Error("rpc down"));
    const result = await attest()(ctx, {
      tenantId: TENANT_A,
      counterpartyId: "cp_1",
      agentId: AGENT_ID,
    });
    expect(result.attested).toBe(false);
    expect(result.reason).toBe("registry_read_failed");
  });

  it("fails closed when the counterparty carries no agent id", async () => {
    const result = await attest()(ctx, {
      tenantId: TENANT_A,
      counterpartyId: "cp_1",
      agentId: null,
    });
    expect(result.attested).toBe(false);
    expect(result.reason).toBe("agent_id_missing");
    expect(readContract).not.toHaveBeenCalled();
  });
});
