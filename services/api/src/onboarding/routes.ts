/**
 * Public self-serve onboarding routes — RFC 0002 Phase B.
 *
 *   POST /v1/signup            → provision a sandbox tenant + owner (email),
 *                                return a verification token (non-prod) / "sent".
 *   POST /v1/auth/verify-email → consume the token, activate the owner.
 *
 * These are the only public (skipAuth) write endpoints. They are registered ONLY
 * when `BRAIN_SELF_SERVE_SIGNUP` is enabled (see main.ts); absent the flag the
 * routes do not exist (404). Both are rate-limited. New tenants are
 * `sandbox = TRUE` and grant NO execution capability — real money stays behind
 * the existing promotion + audit gates (RFC 0002 §9).
 *
 * Verification design: the raw token is single-use and short-TTL; only its
 * sha256 is stored. Verify-email is scoped by `tenant_id` (returned at signup),
 * so the lookup runs inside `withTenantScope` under RLS — a token issued for one
 * tenant can never be redeemed under another's scope.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  brainError,
  hashPassword,
  ID_PREFIX,
  isBrainId,
  withTenantScope,
  type AuditEmitter,
  type TenantScopedClient,
} from "@brain/shared";
import { provisionTenant } from "./provision.js";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface OnboardingDeps {
  readonly pool: Pool;
  readonly audit: AuditEmitter;
  /** When true (non-prod), the signup response includes the raw verification token. */
  readonly exposeVerificationToken: boolean;
}

const signupBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(4096),
});

const verifyBody = z.object({
  tenant_id: z.string().min(1),
  token: z.string().min(1),
});

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function registerOnboardingRoutes(
  app: FastifyInstance,
  deps: OnboardingDeps,
): Promise<void> {
  app.post(
    "/signup",
    { config: { skipAuth: true, rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = signupBody.safeParse(req.body);
      if (!parsed.success) {
        throw brainError("request_body_invalid", "email and password (min 12 chars) are required", {
          details: { issues: parsed.error.issues },
        });
      }
      const email = parsed.data.email.toLowerCase();
      const passwordHash = await hashPassword(parsed.data.password);
      const rawToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

      const { tenantId, userId } = await provisionTenant(deps.pool, {
        email,
        passwordHash,
        emailVerificationTokenHash: sha256Hex(rawToken),
        emailVerificationExpiresAt: expiresAt,
      });

      await deps.audit.emit({
        tenantId,
        layer: "identity",
        actor: userId,
        action: "tenant.created",
        inputs: { created_via: "self_serve" },
        outputs: { tenant_id: tenantId, sandbox: true },
      });
      await deps.audit.emit({
        tenantId,
        layer: "identity",
        actor: userId,
        action: "user.created",
        inputs: { email },
        outputs: { user_id: userId, role: "owner", status: "pending" },
      });

      reply.status(201);
      return {
        tenant_id: tenantId,
        user_id: userId,
        status: "pending",
        ...(deps.exposeVerificationToken
          ? { verification_token: rawToken }
          : { verification_sent: true }),
      };
    },
  );

  app.post(
    "/auth/verify-email",
    { config: { skipAuth: true, rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = verifyBody.safeParse(req.body);
      if (!parsed.success) {
        throw brainError("request_body_invalid", "tenant_id and token are required");
      }
      const { tenant_id: tenantId, token } = parsed.data;
      if (!isBrainId(tenantId, ID_PREFIX.tenant)) {
        throw brainError("request_body_invalid", "invalid tenant_id");
      }
      const tokenHash = sha256Hex(token);

      const userId = await withTenantScope(deps.pool, tenantId, async (c: TenantScopedClient) => {
        const { rows } = await c.query<{ user_id: string }>(
          `SELECT user_id FROM email_verifications
            WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
          [tokenHash],
        );
        const row = rows[0];
        if (row === undefined) {
          throw brainError(
            "signup_token_invalid",
            "verification token is invalid, expired, or already used",
          );
        }
        await c.query(
          "UPDATE users SET status = 'active', email_verified_at = now() WHERE id = $1",
          [row.user_id],
        );
        await c.query("UPDATE email_verifications SET consumed_at = now() WHERE token_hash = $1", [
          tokenHash,
        ]);
        return row.user_id;
      });

      await deps.audit.emit({
        tenantId,
        layer: "identity",
        actor: userId,
        action: "user.email_verified",
        inputs: {},
        outputs: { user_id: userId, status: "active" },
      });

      reply.status(200);
      return { verified: true, user_id: userId, status: "active" };
    },
  );
}
