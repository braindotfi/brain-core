/**
 * Agent identity verification for MCP requests.
 *
 * The Bearer JWT is verified upstream by `authPlugin` (every
 * `/agents/mcp` request goes through it). This module runs the
 * additional MCP-specific checks per the architecture doc:
 *
 *   1. Agent record exists and is `active`.
 *   2. Scope hash matches the on-chain attestation in
 *      BrainMCPAgentRegistry.
 *   3. (Caller-checked) Tool requires a scope the agent holds.
 *   4. Tenant equality between JWT and agent row (defense in depth).
 *
 * The on-chain check (2) is cached in-memory for 60 seconds per
 * (agent_id, scope_hash) pair to keep tool calls hot. A real on-chain
 * mismatch is a security event — we audit the failure and reject the
 * request.
 */

import {
  brainError,
  withTenantScope,
  type Principal,
  type ServiceCallContext,
} from "@brain/api/shared";
import type { Pool } from "pg";

export interface AgentRecord {
  id: string;
  tenant_id: string;
  state: string;
  scope_hash: Buffer | null;
  onchain_address: string | null;
  role: string;
}

export interface OnchainScopeChecker {
  /** Returns the on-chain scope hash for the agent, or null if the agent
   *  is not registered. The hex string excludes the leading 0x. */
  getOnchainScopeHash(agentId: string): Promise<string | null>;
}

export interface AuthVerifier {
  verify(principal: Principal): Promise<{ agent: AgentRecord; ctx: ServiceCallContext }>;
}

interface CacheEntry {
  hash: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

/**
 * The default verifier: reads the agent row from `agents` and validates
 * the on-chain hash via the supplied checker. Constructed once per app
 * boot; the cache is per-instance.
 */
export class McpAuthVerifier implements AuthVerifier {
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(
    private readonly pool: Pool,
    private readonly onchain: OnchainScopeChecker,
  ) {}

  public async verify(
    principal: Principal,
  ): Promise<{ agent: AgentRecord; ctx: ServiceCallContext }> {
    if (principal.type !== "agent") {
      throw brainError("auth_scope_insufficient", "MCP requires principal_type=agent");
    }
    const agent = await this.loadAgent(principal);
    if (agent === null) {
      throw brainError("agent_not_registered", "agent not found in agents table", {
        details: { agent_id: principal.id },
      });
    }
    if (agent.state !== "active") {
      throw brainError("agent_not_registered", `agent state is '${agent.state}'`, {
        details: { agent_id: principal.id, state: agent.state },
      });
    }
    if (agent.tenant_id !== principal.tenantId) {
      throw brainError("auth_tenant_mismatch", "agent tenant does not match JWT tenant");
    }

    if (agent.scope_hash !== null) {
      const offchainHex = Buffer.from(agent.scope_hash).toString("hex");
      const onchainHex = await this.onchainScopeHashCached(agent.id);
      if (onchainHex === null) {
        throw brainError("agent_scope_hash_mismatch", "agent not registered on-chain", {
          details: { agent_id: agent.id },
        });
      }
      if (onchainHex.toLowerCase() !== offchainHex.toLowerCase()) {
        throw brainError("agent_scope_hash_mismatch", "scope hash drift detected", {
          details: { agent_id: agent.id, offchain_hash: offchainHex, onchain_hash: onchainHex },
        });
      }
    }

    return {
      agent,
      ctx: {
        tenantId: principal.tenantId,
        actor: principal.id,
      },
    };
  }

  private async loadAgent(principal: Principal): Promise<AgentRecord | null> {
    return withTenantScope(this.pool, principal.tenantId, async (c) => {
      const { rows } = await c.query<AgentRecord>(
        `SELECT id, tenant_id, state, scope_hash, onchain_address, role
           FROM agents WHERE id = $1 LIMIT 1`,
        [principal.id],
      );
      return rows[0] ?? null;
    });
  }

  private async onchainScopeHashCached(agentId: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.cache.get(agentId);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.hash;
    }
    const hash = await this.onchain.getOnchainScopeHash(agentId);
    if (hash !== null) {
      this.cache.set(agentId, { hash, expiresAt: now + CACHE_TTL_MS });
    }
    return hash;
  }

  /** Test/operations seam: drop the cache (e.g. when an operator rotates
   *  an agent's scope on-chain). */
  public clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Test seam: a verifier that always returns the supplied agent record.
 * Useful for unit tests that don't want to model the agents table.
 */
export class FakeAuthVerifier implements AuthVerifier {
  public constructor(private readonly agent: AgentRecord) {}
  public async verify(
    principal: Principal,
  ): Promise<{ agent: AgentRecord; ctx: ServiceCallContext }> {
    if (principal.type !== "agent") {
      throw brainError("auth_scope_insufficient", "MCP requires principal_type=agent");
    }
    return {
      agent: this.agent,
      ctx: {
        tenantId: principal.tenantId,
        actor: principal.id,
        principalType: principal.type,
        scopes: principal.scopes,
      },
    };
  }
}
