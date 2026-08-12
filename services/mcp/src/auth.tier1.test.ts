/**
 * Tier-1 unattested read-only agent path (RFC 0002 Phase C, increment 1).
 * One test per NEGATED clause in McpAuthVerifier.verify's tier-1 branch,
 * plus the "all four hold" pass case. See services/mcp/src/auth.ts for the
 * clause numbering these tests mirror.
 */
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type * as BrainShared from "@brain/shared";

vi.mock("@brain/shared", async (importActual) => {
  const actual = await importActual<typeof BrainShared>();
  return {
    ...actual,
    withTenantScope: vi.fn(
      async (_pool: unknown, _tenantId: unknown, fn: (c: unknown) => Promise<unknown>) =>
        fn({ query: vi.fn() }),
    ),
  };
});

import { withTenantScope, computeAgentScopeHash } from "@brain/shared";
import { scopesForAgentRole } from "@brain/internal-agents";
import { McpAuthVerifier, type AgentRecord, type OnchainScopeChecker } from "./auth.js";
import type { Principal } from "@brain/shared";

const TENANT = "tnt_01j9z9q9q9q9q9q9q9q9q9q9q9";
const AGENT_ID = "agent_01j9z9q9q9q9q9q9q9q9q9q9q0";

function canonicalHashBuf(role: string): Buffer {
  const hex = computeAgentScopeHash(scopesForAgentRole(role)).slice(2);
  return Buffer.from(hex, "hex");
}

function makePool(): Pool {
  return {} as Pool;
}

function makeChecker(hash: string | null): OnchainScopeChecker {
  return { getOnchainScopeHash: vi.fn(async () => hash) };
}

function principal(scopes: string[]): Principal {
  return {
    id: AGENT_ID,
    type: "agent",
    tenantId: TENANT,
    scopes: scopes as unknown as Principal["scopes"],
    tokenId: "tok_01j9z9q9q9q9q9q9q9q9q9q9q9",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function stubTenantScope(agent: AgentRecord | null) {
  vi.mocked(withTenantScope).mockImplementationOnce(async (_pool, _tenantId, fn) => {
    const client = {
      query: vi.fn(async () => ({ rows: agent !== null ? [agent] : [] })),
    };
    return fn(client as never);
  });
}

describe("McpAuthVerifier tier-1 unattested path", () => {
  it("clause 2: mode='none' with a money-path role still hits the chain and is denied", async () => {
    const role = "payment"; // scopesForAgentRole includes payment_intent:propose -- not a subset of MCP_UNATTESTED_SCOPES
    const agent: AgentRecord = {
      id: AGENT_ID,
      tenant_id: TENANT,
      state: "active",
      scope_hash: canonicalHashBuf(role),
      onchain_address: null,
      role,
      attestation_mode: "none",
    };
    stubTenantScope(agent);
    const checker = makeChecker(null);
    const verifier = new McpAuthVerifier(makePool(), checker);
    await expect(verifier.verify(principal(["ledger:read"]))).rejects.toMatchObject({
      code: "agent_not_registered_onchain",
    });
    expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(1);
  });

  it("clause 3: mode='none' with a read-only role but a non-canonical scope_hash still hits the chain and is denied", async () => {
    const role = "anomaly"; // read-only role
    const agent: AgentRecord = {
      id: AGENT_ID,
      tenant_id: TENANT,
      state: "active",
      scope_hash: Buffer.from("ab".repeat(32), "hex"), // not the canonical derivation for "anomaly"
      onchain_address: null,
      role,
      attestation_mode: "none",
    };
    stubTenantScope(agent);
    const checker = makeChecker(null);
    const verifier = new McpAuthVerifier(makePool(), checker);
    await expect(verifier.verify(principal(["ledger:read"]))).rejects.toMatchObject({
      code: "agent_not_registered_onchain",
    });
    expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(1);
  });

  it("clause 4: mode='none' with a read-only role and canonical hash, but a JWT carrying payment_intent:propose, still hits the chain and is denied", async () => {
    const role = "anomaly";
    const agent: AgentRecord = {
      id: AGENT_ID,
      tenant_id: TENANT,
      state: "active",
      scope_hash: canonicalHashBuf(role),
      onchain_address: null,
      role,
      attestation_mode: "none",
    };
    stubTenantScope(agent);
    const checker = makeChecker(null);
    const verifier = new McpAuthVerifier(makePool(), checker);
    await expect(
      verifier.verify(principal(["ledger:read", "payment_intent:propose"])),
    ).rejects.toMatchObject({
      code: "agent_not_registered_onchain",
    });
    expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(1);
  });

  it("clause 1 (revocation-disarm): mode='onchain_custodial' with a read-only role and a read-only JWT STILL hits the chain and is denied when unregistered", async () => {
    const role = "anomaly";
    const agent: AgentRecord = {
      id: AGENT_ID,
      tenant_id: TENANT,
      state: "active",
      scope_hash: canonicalHashBuf(role),
      onchain_address: null,
      role,
      attestation_mode: "onchain_custodial",
    };
    stubTenantScope(agent);
    const checker = makeChecker(null); // unregistered/revoked on chain
    const verifier = new McpAuthVerifier(makePool(), checker);
    await expect(verifier.verify(principal(["ledger:read", "wiki:read"]))).rejects.toMatchObject({
      code: "agent_not_registered_onchain",
    });
    // The whole point of clause 1: a read-only role/JWT combination that
    // WOULD satisfy clauses 2-4 must not skip the chain just because it
    // looks tier-1-eligible. Revocation must still disarm it.
    expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(1);
  });

  it("all four clauses hold: passes without ever calling the on-chain checker", async () => {
    const role = "anomaly";
    const agent: AgentRecord = {
      id: AGENT_ID,
      tenant_id: TENANT,
      state: "active",
      scope_hash: canonicalHashBuf(role),
      onchain_address: null,
      role,
      attestation_mode: "none",
    };
    stubTenantScope(agent);
    const checker = makeChecker(null);
    const verifier = new McpAuthVerifier(makePool(), checker);
    const result = await verifier.verify(principal(["ledger:read", "wiki:read"]));
    expect(result.ctx.tenantId).toBe(TENANT);
    expect(checker.getOnchainScopeHash).toHaveBeenCalledTimes(0);
  });
});
