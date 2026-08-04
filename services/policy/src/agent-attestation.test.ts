/**
 * C3 regression: gate check 5.5 must bind the agent to the CALLING tenant.
 *
 * `BrainMCPAgentRegistry._agents` is a global namespace, and the registry
 * exposes `isAuthorized(agentId, tenantId)` for exactly this reason. The loader
 * previously read `getAgent` and discarded the `tenantId` it returned, so an
 * agent registered by tenant A satisfied a money-path check made on behalf of
 * tenant B. The 60s cache was keyed on agentId alone, which spread one tenant's
 * verdict to every other tenant for a full TTL.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { keccak256, toHex } from "viem";
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
const AGENT_ID = "0x" + "bb".repeat(32);
const TENANT_A = "tnt_00000000010000000000000000";
const TENANT_B = "tnt_00000000020000000000000000";

const ctx = {} as never;

function registration(overrides: Record<string, unknown> = {}) {
  return {
    agentId: AGENT_ID,
    agentAddress: "0x" + "cc".repeat(20),
    tenantId: keccak256(toHex(TENANT_A)),
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

describe("agent attestation tenant binding", () => {
  it("calls isAuthorized with the keccak256 of the tenant id", async () => {
    readContract.mockResolvedValue(true);
    const result = await attest()(ctx, {
      tenantId: TENANT_A,
      counterpartyId: "cp_1",
      agentId: AGENT_ID,
    });

    expect(result.attested).toBe(true);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "isAuthorized",
        args: [AGENT_ID, keccak256(toHex(TENANT_A))],
      }),
    );
  });

  it("rejects an agent registered under a different tenant", async () => {
    // isAuthorized is false for tenant B; getAgent shows a live registration
    // that belongs to tenant A.
    readContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "isAuthorized") return false;
      return registration();
    });

    const result = await attest()(ctx, {
      tenantId: TENANT_B,
      counterpartyId: "cp_1",
      agentId: AGENT_ID,
    });

    expect(result.attested).toBe(false);
    expect(result.registered).toBe(true);
    expect(result.reason).toBe("agent_tenant_mismatch");
  });

  it("does not leak one tenant's verdict to another through the cache", async () => {
    readContract.mockImplementation(async (args: { functionName: string; args: unknown[] }) => {
      if (args.functionName === "isAuthorized") {
        return args.args[1] === keccak256(toHex(TENANT_A));
      }
      return registration();
    });

    const resolve = attest();
    const a = await resolve(ctx, { tenantId: TENANT_A, counterpartyId: "cp_1", agentId: AGENT_ID });
    const b = await resolve(ctx, { tenantId: TENANT_B, counterpartyId: "cp_1", agentId: AGENT_ID });

    expect(a.attested).toBe(true);
    expect(b.attested).toBe(false);
  });

  it("reports a revoked agent as revoked, never as paused", async () => {
    readContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "isAuthorized") return false;
      return registration({ revokedAt: 99n });
    });

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
    readContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "isAuthorized") return false;
      return registration({ registeredAt: 0n });
    });

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
