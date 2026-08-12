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
  computeAgentScopeHash,
  withTenantScope,
  type Principal,
  type Scope,
  type ServiceCallContext,
} from "@brain/shared";
import { scopesForAgentRole } from "@brain/internal-agents";
import type { Pool } from "pg";

/**
 * Scopes an agent may hold and still skip the on-chain BrainMCPAgentRegistry
 * check (RFC 0002 Phase C, increment 1 -- the tier-1 "unattested read-only
 * agent" path). Deliberately small and read-only: nothing in this set can
 * move money or write Ledger/Raw state.
 */
export const MCP_UNATTESTED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "ledger:read",
  "wiki:read",
  "raw:read",
]);

export interface AgentRecord {
  id: string;
  tenant_id: string;
  state: string;
  scope_hash: Buffer | null;
  onchain_address: string | null;
  role: string;
  /* "none" = tier-1 unattested (see MCP_UNATTESTED_SCOPES above);
   * "tenant_signed" / "onchain_custodial" both still require the
   * BrainMCPAgentRegistry check this file otherwise always ran. */
  attestation_mode: string;
}

export interface OnchainScopeChecker {
  /** Returns the on-chain scope hash for the agent, or null if the agent
   *  is not registered. The hex string excludes the leading 0x. */
  getOnchainScopeHash(agentId: string): Promise<string | null>;
}

/**
 * Thrown by an `OnchainScopeChecker` implementation when the on-chain READ
 * ITSELF failed (RPC/network/decode fault) -- distinct from a clean "not
 * registered" result, which still returns `null`. Before this type existed
 * both cases collapsed to `null`, so a chain outage silently downgraded to
 * "agent has no on-chain scope" instead of a diagnosable failure. Callers
 * that must fail closed on an outage (McpAuthVerifier.verify,
 * assertScopeHashAcceptable) let this propagate rather than catching it.
 */
export class OnchainScopeUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OnchainScopeUnavailableError";
  }
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
 * Wraps any `OnchainScopeChecker` with a 60-second in-memory cache keyed by
 * agent id. Extracted out of `McpAuthVerifier` so the exact same cached
 * reader can be reused by other on-chain-preferred scope checks (see
 * `assertScopeHashAcceptable` below) instead of a second on-chain reader
 * with its own cache.
 */
export class CachedOnchainScopeChecker implements OnchainScopeChecker {
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(private readonly onchain: OnchainScopeChecker) {}

  public async getOnchainScopeHash(agentId: string): Promise<string | null> {
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

  /**
   * Operations seam for scope rotation. When an operator updates an agent's
   * on-chain scope attestation in BrainMCPAgentRegistry, the previous hash is
   * cached in-process for up to {@link CACHE_TTL_MS}. Calling this with the
   * affected agent id drops just that entry so the next read re-checks chain
   * and either picks up the new hash or hard-rejects on mismatch.
   *
   * Called with no argument (or `undefined`), clears every entry — used by
   * tests and as a panic button if the on-chain checker itself rotates.
   */
  public clearCache(agentId?: string): void {
    if (agentId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(agentId);
  }
}

/**
 * The default verifier: reads the agent row from `agents` and validates
 * the on-chain hash via the supplied checker. Constructed once per app
 * boot; the cache is per-instance.
 */
export class McpAuthVerifier implements AuthVerifier {
  private readonly cachedOnchain: CachedOnchainScopeChecker;

  public constructor(
    private readonly pool: Pool,
    onchain: OnchainScopeChecker,
  ) {
    this.cachedOnchain = new CachedOnchainScopeChecker(onchain);
  }

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

    if (agent.scope_hash === null) {
      throw brainError("agent_scope_hash_missing", "agent has no on-chain scope attestation", {
        details: { agent_id: agent.id },
      });
    }

    // Tier-1 unattested read-only path (RFC 0002 Phase C, increment 1). Skips
    // the BrainMCPAgentRegistry read below ONLY when all four clauses hold --
    // each closes a distinct bypass, so none may be dropped or merged.
    if (agent.attestation_mode === "none") {
      // Clause 1 (this `if`): the agent row itself must be enrolled as
      // unattested. A tenant_signed/onchain_custodial agent always takes the
      // on-chain path below, whatever its role or JWT scopes look like.
      const roleScopes = scopesForAgentRole(agent.role);
      // Clause 2: the agent's REGISTERED role must be read-only and fully
      // contained in MCP_UNATTESTED_SCOPES. Without this, registering an
      // agent under a money-path role (e.g. "payment") with
      // attestation_mode="none" would skip the chain for a scope set that
      // can move money.
      const roleIsUnattestedEligible =
        roleScopes.length > 0 && roleScopes.every((s) => MCP_UNATTESTED_SCOPES.has(s));
      // Clause 3: the DB scope_hash must be exactly the canonical derivation
      // for that role, not a stale, hand-planted, or previously on-chain
      // value that happens to still be stored. Prevents scope carried over
      // from a broader grant from riding the unattested path.
      const canonicalHex = computeAgentScopeHash(roleScopes).slice(2).toLowerCase();
      const offchainHexLower = Buffer.from(agent.scope_hash).toString("hex").toLowerCase();
      const scopeHashIsCanonical = offchainHexLower === canonicalHex;
      // Clause 4: the JWT actually presented on THIS request must also be
      // fully contained in MCP_UNATTESTED_SCOPES. The registered role can be
      // read-only while a specific token still carries a wider grant (e.g. a
      // legacy token minted before the role narrowed); reject that here
      // rather than trusting the role alone.
      const requestScopesAreUnattestedEligible = principal.scopes.every((s) =>
        MCP_UNATTESTED_SCOPES.has(s),
      );
      if (roleIsUnattestedEligible && scopeHashIsCanonical && requestScopesAreUnattestedEligible) {
        return {
          agent,
          ctx: {
            tenantId: principal.tenantId,
            actor: principal.id,
          },
        };
      }
      // Any clause failing falls through to the strict on-chain path below --
      // deliberately, so a misconfigured tier-1 agent is never silently
      // waved through; it gets the same registry check as a custodial agent.
    }

    const offchainHex = Buffer.from(agent.scope_hash).toString("hex");
    let onchainHex: string | null;
    try {
      onchainHex = await this.cachedOnchain.getOnchainScopeHash(agent.id);
    } catch (err) {
      if (err instanceof OnchainScopeUnavailableError) {
        // Not a posture change: an outage already denied every call before
        // this error type existed (getOnchainScopeHash collapsed it to null,
        // which the branch right below already rejected). Only the
        // diagnosis changes -- operators can now tell "chain unreachable"
        // apart from "chain confirms not registered".
        throw brainError("agent_not_registered_onchain", "on-chain scope check unavailable", {
          details: { agent_id: agent.id, reason: "onchain_unavailable" },
        });
      }
      throw err;
    }
    if (onchainHex === null) {
      throw brainError("agent_not_registered_onchain", "agent not registered on-chain", {
        details: { agent_id: agent.id },
      });
    }
    if (onchainHex.toLowerCase() !== offchainHex.toLowerCase()) {
      throw brainError("agent_scope_hash_mismatch", "scope hash drift detected", {
        details: { agent_id: agent.id, offchain_hash: offchainHex, onchain_hash: onchainHex },
      });
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
        `SELECT id, tenant_id, state, scope_hash, onchain_address, role, attestation_mode
           FROM agents WHERE id = $1 LIMIT 1`,
        [principal.id],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Operations seam for scope rotation. Delegates to the wrapped
   * `CachedOnchainScopeChecker` — see its `clearCache` doc.
   */
  public clearCache(agentId?: string): void {
    this.cachedOnchain.clearCache(agentId);
  }
}

/**
 * Test seam / dev-bypass verifier that always returns the supplied agent record.
 * Skips the principal_type check so demo user tokens can call MCP tools in
 * BRAIN_MCP_DEV_AUTH_BYPASS=true mode. Production uses McpAuthVerifier.
 */
export class FakeAuthVerifier implements AuthVerifier {
  public constructor(private readonly agent: AgentRecord) {}
  public async verify(
    principal: Principal,
  ): Promise<{ agent: AgentRecord; ctx: ServiceCallContext }> {
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

/**
 * Scope-hash acceptance rule, on-chain preferred (2026-07-28 seeder audit).
 *
 * `agents.scope_hash` must be one of two things, in this preference order:
 *
 *   1. Registered on-chain: the DB hash must equal the on-chain attestation
 *      in BrainMCPAgentRegistry (identical rule to McpAuthVerifier.verify
 *      above — a registered agent's chain record is always authoritative).
 *   2. Not registered on-chain: the DB hash must equal
 *      `computeAgentScopeHash(expectedScopes)`, the canonical derivation for
 *      the agent's role.
 *
 * Why on-chain wins even over the canonical formula: one live agent
 * (agent_01KTB9KXM267ZEEBAMYMNSYE6X, tenant tnt_00000000010000000000000000)
 * is registered on-chain under the pre-computeAgentScopeHash formula the old
 * seed-golden-path seeder used (plain SHA-256 of `${tenantId}:payment`).
 * Chain and DB agree with each other, and the agent has authenticated
 * successfully over MCP for 24+ days, so preferring the on-chain value when
 * one exists keeps it working while still forcing canonical derivation on
 * every agent not yet attested on chain.
 *
 * Used by callers that mint tokens or accept registrations for agents that
 * are not necessarily `active`/on-chain yet (SIWX issuance, agent
 * registration) — McpAuthVerifier keeps its own stricter always-on-chain
 * gate unchanged.
 */
export async function assertScopeHashAcceptable(params: {
  agentId: string;
  scopeHash: Buffer | null;
  expectedScopes: readonly Scope[];
  onchain: OnchainScopeChecker;
  /**
   * RFC 0002 Phase C, increment 1. "none" (tier-1 unattested) skips the
   * on-chain read entirely and requires only the canonical derivation --
   * mirrors the McpAuthVerifier.verify tier-1 branch above. Any other value
   * (e.g. "tenant_signed", "onchain_custodial") keeps the existing
   * on-chain-preferred rule below unchanged.
   */
  attestationMode: string;
}): Promise<void> {
  const { agentId, scopeHash, expectedScopes, onchain, attestationMode } = params;
  if (scopeHash === null) {
    throw brainError("agent_scope_hash_missing", "agent has no scope attestation", {
      details: { agent_id: agentId },
    });
  }
  const offchainHex = Buffer.from(scopeHash).toString("hex");
  const canonicalHex = computeAgentScopeHash(expectedScopes).slice(2).toLowerCase();
  if (attestationMode === "none") {
    if (offchainHex.toLowerCase() !== canonicalHex) {
      throw brainError(
        "agent_scope_hash_mismatch",
        "scope hash is not the canonical derivation for this unattested role",
        {
          details: { agent_id: agentId, offchain_hash: offchainHex, canonical_hash: canonicalHex },
        },
      );
    }
    return;
  }
  // This call is deliberately unwrapped: OnchainScopeUnavailableError must
  // propagate out of it so a chain outage fails token minting/consent closed
  // instead of silently falling through to the canonical-derivation check
  // below. (Pinned: check-invariants.mjs, "assertScopeHashAcceptable has no
  // catch around the on-chain read".)
  const onchainHex = await onchain.getOnchainScopeHash(agentId);
  if (onchainHex !== null) {
    if (onchainHex.toLowerCase() !== offchainHex.toLowerCase()) {
      throw brainError(
        "agent_scope_hash_mismatch",
        "scope hash drift detected against on-chain attestation",
        {
          details: { agent_id: agentId, offchain_hash: offchainHex, onchain_hash: onchainHex },
        },
      );
    }
    return;
  }
  if (offchainHex.toLowerCase() !== canonicalHex) {
    throw brainError(
      "agent_scope_hash_mismatch",
      "scope hash is neither on-chain registered nor the canonical derivation for this role",
      { details: { agent_id: agentId, offchain_hash: offchainHex, canonical_hash: canonicalHex } },
    );
  }
}
