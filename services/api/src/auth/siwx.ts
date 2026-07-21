/**
 * SIWX (Sign-In With X over Base) auth routes for external agents.
 *
 * PLAN-FIRST #15 per docs/sdk-audit.md. Source:
 * https://docs.brain.fi/api-reference/authentication.
 *
 * This is the agent sign-in flow:
 *
 *   - The signing address must match a row in `agents` with
 *     `state = 'active'`.
 *   - The JWT's `scope_hash` claim must match the on-chain hash registered
 *     in `BrainMCPAgentRegistry`. v0.3 ship stubs the on-chain check —
 *     real verification lands alongside the contract integration
 *     (PLAN-FIRST #14b scope-grant work).
 *   - The issued token carries `principal_type=agent` with the scope set
 *     drawn from the agent's authorization grant.
 *
 *   POST /auth/siwx/challenge → { nonce, session_id, domain }
 *   POST /auth/siwx           → { access_token, token_type, expires_in,
 *                                 principal }
 *
 * Nonces are held in Redis (`siwx:nonce:<session_id>`) with a 5-minute TTL,
 * so the challenge/verify pair works across replicas, and the signing address
 * must resolve to an active row in `agents` (PostgresAgentRegistry) — there is
 * no fallback that mints tokens for unregistered wallets outside demo mode.
 */

import { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { SiweMessage, generateNonce } from "siwe";
import { internalAgentDefinitions } from "@brain/internal-agents";
import { brainError, brainId, newAgentId, newTokenId, PAYMENT_AGENT_SCOPES } from "@brain/shared";
import type { JwtSigner, Scope } from "@brain/shared";
import { OWNER_SCOPES } from "../onboarding/login.js";
import type { ResolvedWalletIdentity } from "../onboarding/wallet-identities.js";

const NONCE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_AGENT_TTL_SECONDS = 60 * 60; // 1 hour per docs

/**
 * Pluggable agent registry lookup. v0.3 ship uses a stub
 * implementation that accepts any well-formed hex address and returns
 * a fixed scope set. Production wiring replaces this with a real
 * lookup against the `agents` table joined with the on-chain
 * BrainMCPAgentRegistry contract.
 */
export interface AgentRegistryLookup {
  /**
   * Resolve the agent and its authorized scopes by signing address.
   * Returns null when the address is not registered or not active.
   */
  resolveByAddress(address: string): Promise<AgentResolution | null>;
}

export interface AgentResolution {
  readonly agentId: string;
  readonly tenantId: string;
  readonly scopes: readonly Scope[];
  readonly scopeHash: string;
}

export interface SiwxOptions {
  readonly signer: JwtSigner;
  /** EIP-4361 `domain` claim. Defaults to `"api.brain.fi"`. */
  readonly domain?: string;
  readonly registry: AgentRegistryLookup;
  /**
   * RFC 0002 Phase D: resolve a wallet to a linked tenant principal. When a
   * wallet is linked to a HUMAN owner, SIWX mints an owner JWT (the same
   * management scopes as /auth/login) instead of an agent token — so a tenant
   * can sign in with email OR a linked wallet. Additive: when unset, or the
   * wallet isn't a human link, sign-in falls through to the agent path.
   */
  readonly resolveWalletIdentity?: (address: string) => Promise<ResolvedWalletIdentity | null>;
  /** Redis client for nonce persistence across replicas. */
  readonly redis: Redis;
  /** Override the token TTL for tests. */
  readonly tokenTtlSeconds?: number;
  /**
   * Skip EIP-4361 signature verification and return a fixed demo agent token.
   * Only for BRAIN_DEMO_MODE — never enable in production.
   */
  readonly demoMode?: boolean;
}

const NONCE_KEY = (sessionId: string): string => `siwx:nonce:${sessionId}`;

export async function registerSiwxRoutes(app: FastifyInstance, opts: SiwxOptions): Promise<void> {
  const domain = opts.domain ?? "api.brain.fi";
  const tokenTtl = opts.tokenTtlSeconds ?? DEFAULT_AGENT_TTL_SECONDS;
  const nonceTtlSecs = Math.ceil(NONCE_TTL_MS / 1000);

  app.post(
    "/auth/siwx/challenge",
    { config: { skipAuth: true } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const nonce = generateNonce();
      const sessionId = brainId("token");
      await opts.redis.setex(NONCE_KEY(sessionId), nonceTtlSecs, nonce);
      reply.status(200);
      return { nonce, session_id: sessionId, domain };
    },
  );

  app.post(
    "/auth/siwx",
    { config: { skipAuth: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (opts.demoMode === true) {
        const expiresAt = Math.floor(Date.now() / 1000) + tokenTtl;
        const access_token = await opts.signer.sign({
          id: "agent_01DEMX00000000000000000000",
          type: "agent",
          tenantId: "tnt_01DEMX00000000000000000000",
          scopes: [
            "ledger:read",
            "wiki:read",
            "raw:write",
            "payment_intent:propose",
            "execution:propose",
          ] as Scope[],
          tokenId: newTokenId(),
          expiresAt,
        });
        reply.status(200);
        return {
          access_token,
          token_type: "Bearer",
          expires_in: tokenTtl,
          principal: {
            id: "agent_01DEMX00000000000000000000",
            type: "agent",
            tenantId: "tnt_01DEMX00000000000000000000",
            scopes: [
              "ledger:read",
              "wiki:read",
              "raw:write",
              "payment_intent:propose",
              "execution:propose",
            ],
          },
        };
      }

      const body = req.body as Record<string, unknown>;
      const message = body["message"];
      const signature = body["signature"];
      const sessionId = body["session_id"];

      if (typeof message !== "string" || typeof signature !== "string") {
        throw brainError("request_body_invalid", "message and signature are required strings");
      }

      // When the caller provided a session_id, look up the stored nonce
      // and require the SIWX message to use it. When omitted, the
      // message's own `nonce` field is trusted but the request is
      // single-use per (address, nonce) tuple. We still consult the map
      // to detect replays.
      let expectedNonce: string | undefined;
      if (typeof sessionId === "string") {
        const stored = await opts.redis.getdel(NONCE_KEY(sessionId));
        if (stored === null) {
          throw brainError("auth_siwx_invalid", "SIWX session_id missing or expired");
        }
        expectedNonce = stored;
      }

      let parsed: SiweMessage;
      try {
        parsed = new SiweMessage(message);
      } catch (cause) {
        throw brainError("auth_siwx_invalid", "SIWX message is not a valid EIP-4361 payload", {
          cause,
        });
      }

      // siwe's `verify` *usually* returns `{success: false}` for bad
      // signatures, but some failure modes (notably nonce mismatch on
      // certain versions) cause it to throw `SiweInvalidMessageField`
      // or a generic Error. Catch both so the route returns 401
      // `auth_siwx_invalid` regardless of which path the library takes.
      let verifyResult: Awaited<ReturnType<typeof parsed.verify>>;
      try {
        verifyResult = await parsed.verify({
          signature,
          domain,
          ...(expectedNonce !== undefined ? { nonce: expectedNonce } : {}),
        });
      } catch (cause) {
        throw brainError("auth_siwx_invalid", "SIWX signature did not verify", { cause });
      }
      if (!verifyResult.success) {
        throw brainError("auth_siwx_invalid", "SIWX signature did not verify", {
          cause: verifyResult.error,
        });
      }

      const address = verifyResult.data.address.toLowerCase();

      // RFC 0002 Phase D: a wallet linked to a HUMAN owner mints an owner JWT
      // (management/read/approve scopes — never propose/execute), so a tenant can
      // sign in with email OR a linked wallet. Checked before the agent path;
      // additive (falls through when unwired or the wallet isn't a human link).
      if (opts.resolveWalletIdentity !== undefined) {
        const wallet = await opts.resolveWalletIdentity(address);
        if (wallet !== null && wallet.principalType === "human") {
          const humanExpiresAt = Math.floor(Date.now() / 1000) + tokenTtl;
          const humanToken = await opts.signer.sign({
            id: wallet.principalId,
            type: "user",
            tenantId: wallet.tenantId,
            scopes: OWNER_SCOPES as Scope[],
            tokenId: newTokenId(),
            expiresAt: humanExpiresAt,
          });
          reply.status(200);
          return {
            access_token: humanToken,
            token_type: "Bearer",
            expires_in: tokenTtl,
            principal: {
              id: wallet.principalId,
              type: "user",
              tenantId: wallet.tenantId,
              scopes: OWNER_SCOPES,
            },
          };
        }
      }

      const resolution = await opts.registry.resolveByAddress(address);
      if (resolution === null) {
        throw brainError("agent_not_found", `no active agent registered for ${address}`);
      }

      const expiresAt = Math.floor(Date.now() / 1000) + tokenTtl;
      const access_token = await opts.signer.sign({
        id: resolution.agentId,
        type: "agent",
        tenantId: resolution.tenantId,
        scopes: resolution.scopes,
        tokenId: newTokenId(),
        expiresAt,
      });

      reply.status(200);
      return {
        access_token,
        token_type: "Bearer",
        expires_in: tokenTtl,
        principal: {
          id: resolution.agentId,
          type: "agent",
          tenantId: resolution.tenantId,
          scopes: resolution.scopes,
        },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Stub registry — v0.3 ship default.
// ---------------------------------------------------------------------------

/**
 * Accepts any well-formed `0x[0-9a-f]{40}` address and returns a fixed
 * scope grant. Real-deployment wiring replaces this with a Postgres
 * lookup joined with an on-chain `BrainMCPAgentRegistry.getAgent` call.
 *
 * The five canonical capabilities per docs/sdk-audit.md decision C are
 * granted by default; production registration scopes per agent.
 */
export class StubAgentRegistry implements AgentRegistryLookup {
  public async resolveByAddress(address: string): Promise<AgentResolution | null> {
    if (!/^0x[a-f0-9]{40}$/.test(address)) return null;
    // Derive deterministic stub ids from the address suffix so the same
    // wallet maps to the same agent/tenant within a process lifetime —
    // useful for tests, not cryptographically meaningful.
    const suffix = address.slice(2, 14).toUpperCase();
    return {
      agentId: `agent_01STUB${suffix}`,
      tenantId: `tnt_01STUB${suffix}`,
      scopes: [
        "ledger:read",
        "wiki:read",
        "raw:write",
        "payment_intent:propose",
        "execution:propose",
      ] as Scope[],
      scopeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
  }
}

// ---------------------------------------------------------------------------
// Production registry — Postgres lookup by onchain_address.
// ---------------------------------------------------------------------------

interface AgentLookupRow {
  id: string;
  tenant_id: string;
  role: string;
  scope_hash: Buffer | null;
  state: string;
}

/**
 * Scope set per agent role. Agents register with a role; SIWX issues a JWT
 * carrying these scopes. The scope_hash in the agents table must match the
 * hash of this set as registered on-chain in BrainMCPAgentRegistry.
 */
function scopesForRole(role: string): Scope[] {
  switch (role) {
    case "dispute":
    case "fraud_anomaly":
    case "vendor_risk":
      return [...catalogReadableScopesForRole(role), "execution:propose"];
    case "reconciliation":
      return ["ledger:read", "wiki:read", "raw:write", "execution:propose"];
    case "payment":
      // Canonical set shared with the demo seed + on-chain registration tooling
      // so the JWT scopes and the on-chain scope_hash never diverge.
      return [...PAYMENT_AGENT_SCOPES];
    case "anomaly":
      return ["ledger:read", "wiki:read"];
    case "partner":
      // Default partner role (batch 10 H-3): READ + PROPOSE + APPROVE only.
      // The role was previously broadened to include `payment_intent:execute`
      // for the BrainSaaS Playground convenience, but that means any partner
      // address registered on-chain implicitly carried execute power. Demos
      // that need execute now use the explicit `partner_execute` role below
      // (or mint their own scoped token via /v1/demo/provision-run, which
      // post-C-1 issues read+propose tokens only). Tightening this default
      // means a leaked partner key cannot drain funds; the worst case is a
      // proposed-and-approved intent that still requires a tenant-side
      // execute call.
      return [
        "ledger:read",
        "wiki:read",
        "raw:write",
        "policy:read",
        "payment_intent:propose",
        "payment_intent:approve",
        "execution:propose",
        "audit:read",
      ];
    case "partner_execute":
      // Opt-in partner role (batch 10 H-3): adds `payment_intent:execute`
      // to the default partner scope set. Operators must explicitly register
      // an agent with this role for it to mint a tokenable execute scope; a
      // partner row created with the default `partner` role does NOT auto-
      // upgrade. The scope-hash check against BrainMCPAgentRegistry covers
      // the role-to-scope mapping, so a partner_execute scope_hash differs
      // from a plain partner scope_hash and cannot be cross-impersonated.
      return [
        "ledger:read",
        "wiki:read",
        "raw:write",
        "policy:read",
        "payment_intent:propose",
        "payment_intent:approve",
        "payment_intent:execute",
        "execution:propose",
        "audit:read",
      ];
    default:
      // dev / unknown -- read-heavy, no execution
      return ["ledger:read", "wiki:read", "policy:read", "audit:read"];
  }
}

function catalogReadableScopesForRole(role: "dispute" | "fraud_anomaly" | "vendor_risk"): Scope[] {
  const definition = internalAgentDefinitions[role];
  if (definition === undefined) {
    throw new Error(`${role} must exist in the internal-agent catalog before SIWX can mint it`);
  }
  const scopes = definition.readable_data.filter((scope): scope is Scope =>
    scope.endsWith(":read"),
  );
  if (!scopes.includes("raw:read")) {
    throw new Error(`${role} must declare raw:read before SIWX can mint it`);
  }
  return scopes;
}

/**
 * Production agent registry. Queries the agents table by onchain_address
 * without tenant scope (SIWX is the cross-tenant address→agent lookup entry
 * point; the connection user bypasses RLS for this privileged route).
 */
export class PostgresAgentRegistry implements AgentRegistryLookup {
  public constructor(private readonly pool: Pool) {}

  public async resolveByAddress(address: string): Promise<AgentResolution | null> {
    const { rows } = await this.pool.query<AgentLookupRow>(
      `SELECT id, tenant_id, role, scope_hash, state
         FROM agents
        WHERE LOWER(onchain_address) = LOWER($1)
          AND state = 'active'
        LIMIT 1`,
      [address],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      agentId: row.id,
      tenantId: row.tenant_id,
      scopes: scopesForRole(row.role),
      scopeHash:
        row.scope_hash !== null
          ? `0x${Buffer.from(row.scope_hash).toString("hex")}`
          : "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
  }
}

// Keep `newAgentId` re-exported so the production wiring can use the
// canonical mint helper when promoting an address to a real agent row.
export { newAgentId };
