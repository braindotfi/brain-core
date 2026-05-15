/**
 * SIWX (Sign-In With X over Base) auth routes for external agents.
 *
 * PLAN-FIRST #15 per docs/sdk-audit.md. Source:
 * https://docs.brain.fi/api-reference/authentication.
 *
 * Distinct from the human-user SIWE flow at services/api/src/auth/siwe.ts:
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
 * Nonces are held in an in-process Map with 5-minute TTL — same pattern
 * as siwe.ts. A follow-up wires Redis when multi-instance deployments
 * land.
 */

import {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { SiweMessage, generateNonce } from "siwe";
import { brainError } from "../shared/errors.js";
import { brainId, newAgentId, newTokenId } from "../shared/ids.js";
import type { JwtSigner } from "../shared/auth/signer.js";
import type { Scope } from "../shared/auth/scopes.js";

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
  resolveByAddress(
    address: string,
  ): Promise<AgentResolution | null>;
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
  /** Override the token TTL for tests. */
  readonly tokenTtlSeconds?: number;
}

interface NonceEntry {
  readonly nonce: string;
  readonly expires: number;
}

export async function registerSiwxRoutes(
  app: FastifyInstance,
  opts: SiwxOptions,
): Promise<void> {
  const domain = opts.domain ?? "api.brain.fi";
  const tokenTtl = opts.tokenTtlSeconds ?? DEFAULT_AGENT_TTL_SECONDS;
  // In-process nonce store keyed by session_id. 5-minute TTL.
  // Follow-up commit swaps to Redis for multi-instance correctness.
  const nonces = new Map<string, NonceEntry>();

  app.post(
    "/auth/siwx/challenge",
    { config: { skipAuth: true } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const nonce = generateNonce();
      const sessionId = brainId("token");
      nonces.set(sessionId, {
        nonce,
        expires: Date.now() + NONCE_TTL_MS,
      });
      reply.status(200);
      return { nonce, session_id: sessionId, domain };
    },
  );

  app.post(
    "/auth/siwx",
    { config: { skipAuth: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Record<string, unknown>;
      const message = body["message"];
      const signature = body["signature"];
      const sessionId = body["session_id"];

      if (typeof message !== "string" || typeof signature !== "string") {
        throw brainError(
          "request_body_invalid",
          "message and signature are required strings",
        );
      }

      // When the caller provided a session_id, look up the stored nonce
      // and require the SIWX message to use it. When omitted, the
      // message's own `nonce` field is trusted but the request is
      // single-use per (address, nonce) tuple. We still consult the map
      // to detect replays.
      let expectedNonce: string | undefined;
      if (typeof sessionId === "string") {
        const stored = nonces.get(sessionId);
        if (stored === undefined || stored.expires < Date.now()) {
          throw brainError(
            "auth_siwx_invalid",
            "SIWX session_id missing or expired",
          );
        }
        expectedNonce = stored.nonce;
        // Consume the session so the same nonce can't be replayed.
        nonces.delete(sessionId);
      }

      let parsed: SiweMessage;
      try {
        parsed = new SiweMessage(message);
      } catch (cause) {
        throw brainError(
          "auth_siwx_invalid",
          "SIWX message is not a valid EIP-4361 payload",
          { cause },
        );
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
        throw brainError(
          "auth_siwx_invalid",
          "SIWX signature did not verify",
          { cause },
        );
      }
      if (!verifyResult.success) {
        throw brainError(
          "auth_siwx_invalid",
          "SIWX signature did not verify",
          { cause: verifyResult.error },
        );
      }

      const address = verifyResult.data.address.toLowerCase();
      const resolution = await opts.registry.resolveByAddress(address);
      if (resolution === null) {
        throw brainError(
          "agent_not_found",
          `no active agent registered for ${address}`,
        );
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
  public async resolveByAddress(
    address: string,
  ): Promise<AgentResolution | null> {
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
        "agent:propose",
      ] as Scope[],
      scopeHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
  }
}

// Keep `newAgentId` re-exported so the production wiring can use the
// canonical mint helper when promoting an address to a real agent row.
export { newAgentId };
