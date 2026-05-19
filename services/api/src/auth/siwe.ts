/**
 * SIWE (Sign-In with Ethereum) auth routes.
 *
 * Implements a simple nonce-based challenge-response flow:
 *   GET  /auth/nonce   → { nonce, session_id }
 *   POST /auth/verify  → { token, principal }  (verifies SIWE message + sig)
 *   POST /auth/logout  → { ok: true }
 *
 * Session state (nonce ↔ session_id) is held in-process for v0.3.
 * TODO: replace with a Redis-backed store for production multi-instance deployments.
 */

import { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { SiweMessage, generateNonce } from "siwe";
import { brainId, newTokenId, brainError } from "@brain/shared";
import type { JwtSigner, Scope } from "@brain/shared";

export interface SiweOptions {
  signer: JwtSigner;
  /** Domain for SIWE messages. */
  domain: string;
  /** Origin for SIWE messages. */
  origin: string;
}

interface NonceEntry {
  nonce: string;
  expires: number;
}

export async function registerSiweRoutes(app: FastifyInstance, opts: SiweOptions): Promise<void> {
  // In-process nonce map keyed by session_id.
  // TODO: replace with Redis-backed store for production multi-instance deployments.
  const nonces = new Map<string, NonceEntry>();

  /**
   * GET /auth/nonce — returns a fresh nonce and a session_id.
   * The client must echo session_id back in the X-Siwe-Session header
   * on the /auth/verify request.
   */
  app.get(
    "/auth/nonce",
    { config: { skipAuth: true } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const nonce = generateNonce();
      const sessionId = brainId("token");
      nonces.set(sessionId, {
        nonce,
        expires: Date.now() + 5 * 60 * 1000, // 5 minutes
      });
      reply.send({ nonce, session_id: sessionId });
    },
  );

  /**
   * POST /auth/verify — verifies the SIWE message and signature,
   * returns a signed Brain JWT.
   *
   * Body: { message: string, signature: string, session_id: string }
   */
  app.post(
    "/auth/verify",
    { config: { skipAuth: true } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Record<string, unknown>;
      const message = body["message"];
      const signature = body["signature"];
      const sessionId = body["session_id"];

      if (
        typeof message !== "string" ||
        typeof signature !== "string" ||
        typeof sessionId !== "string"
      ) {
        throw brainError(
          "request_body_invalid",
          "message, signature, and session_id are required strings",
        );
      }

      const stored = nonces.get(sessionId);
      if (stored === undefined || stored.expires < Date.now()) {
        throw brainError("auth_token_invalid", "SIWE nonce missing or expired");
      }

      const siweMessage = new SiweMessage(message);
      const result = await siweMessage.verify({
        signature,
        nonce: stored.nonce,
        domain: opts.domain,
      });

      if (!result.success) {
        throw brainError("auth_token_invalid", "SIWE verification failed", {
          cause: result.error,
        });
      }

      // Clear nonce after successful verification (one-time use).
      nonces.delete(sessionId);

      // Map wallet address to user and tenant.
      // TODO: replace with a real DB lookup when the users table is wired.
      const { userId, tenantId } = resolveUserAndTenant(result.data.address);

      // Demo scopes — production will derive scopes from the user record.
      const demoScopes: Scope[] = ["wiki:read", "raw:write", "execution:propose"];

      const principal = {
        id: userId,
        type: "user" as const,
        tenantId,
        scopes: demoScopes,
        tokenId: newTokenId(),
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24 hours
      };

      const token = await opts.signer.sign(principal);
      reply.send({ token, principal });
    },
  );

  /**
   * POST /auth/logout — no-op for now (JWTs are stateless, revocation
   * is a TODO). Returns ok so clients can clear their local token.
   */
  app.post(
    "/auth/logout",
    { config: { skipAuth: true } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.send({ ok: true });
    },
  );
}

/**
 * Placeholder for user/tenant resolution.
 * TODO: replace with a real DB lookup. The mapping from wallet address to
 * Brain user/tenant lands when the users table and onboarding flow ship.
 */
function resolveUserAndTenant(address: string): { userId: string; tenantId: string } {
  // Derive stable demo IDs from the address so the same wallet gets the
  // same IDs within one process lifetime. Not cryptographically meaningful.
  const suffix = address.slice(2, 28).toUpperCase();
  return {
    userId: `user_01${suffix}`,
    tenantId: `tnt_01${suffix}`,
  };
}
