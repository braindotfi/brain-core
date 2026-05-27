/**
 * Human (owner) password login — RFC 0002 Phase B.
 *
 *   POST /v1/auth/login → email + password → owner JWT.
 *
 * This is the human-principal analogue of SIWX (the wallet/agent entry point):
 * it resolves a user by email across tenants (a sanctioned privileged read, like
 * the SIWX address→agent lookup — uses the brain_privileged pool), verifies the
 * scrypt password hash, requires the email to be verified (`status = active`),
 * and mints a short-lived JWT.
 *
 * Scopes (RFC 0002 O-5): management + read + approve ONLY. The owner JWT
 * deliberately carries **no** `*:execute`, `payment_intent:propose`, or
 * `execution:propose` — money movement is an agent + §6-gate concern, never a
 * human-login capability.
 *
 * Anti-enumeration: an unknown email and a wrong password return the SAME
 * `auth_invalid_credentials` (401), and a dummy hash is verified when the email
 * is unknown so the response timing does not reveal whether the email exists.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import {
  brainError,
  newTokenId,
  verifyPassword,
  type AuditEmitter,
  type JwtSigner,
  type Scope,
} from "@brain/shared";

/** Owner/operator scope set — management + read + approve; never propose/execute. */
export const OWNER_SCOPES: readonly Scope[] = [
  "ledger:read",
  "wiki:read",
  "policy:read",
  "policy:write",
  "audit:read",
  "execution:read",
  "payment_intent:approve",
];

/** A non-secret scrypt hash used only to equalize timing on unknown-email logins. */
const DUMMY_HASH = "scrypt$32768$8$1$ZHVtbXlfc2FsdF8xNg$ZHVtbXlfZGVyaXZlZF9rZXlfMzJfYnl0ZXNfX18";

export interface UserCredential {
  readonly userId: string;
  readonly tenantId: string;
  readonly status: string;
  readonly passwordHash: string | null;
}

export type ResolveUserByEmail = (email: string) => Promise<UserCredential | null>;

export interface LoginDeps {
  readonly resolveUserByEmail: ResolveUserByEmail;
  readonly signer: JwtSigner;
  readonly audit: AuditEmitter;
  readonly tokenTtlSeconds: number;
}

const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(4096),
});

export async function registerPasswordLoginRoute(
  app: FastifyInstance,
  deps: LoginDeps,
): Promise<void> {
  app.post(
    "/auth/login",
    { config: { skipAuth: true, rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) {
        throw brainError("request_body_invalid", "email and password are required");
      }
      const email = parsed.data.email.toLowerCase();
      const cred = await deps.resolveUserByEmail(email);

      // Always run a verify (against a dummy hash when the email is unknown) so an
      // attacker cannot distinguish "no such email" from "wrong password" by timing.
      const hashToCheck = cred?.passwordHash ?? DUMMY_HASH;
      const passwordOk = await verifyPassword(parsed.data.password, hashToCheck);

      if (cred === null || cred.passwordHash === null || !passwordOk) {
        throw brainError("auth_invalid_credentials", "invalid email or password");
      }
      if (cred.status !== "active") {
        throw brainError("auth_email_unverified", "verify your email before signing in");
      }

      const expiresAt = Math.floor(Date.now() / 1000) + deps.tokenTtlSeconds;
      const accessToken = await deps.signer.sign({
        id: cred.userId,
        type: "user",
        tenantId: cred.tenantId,
        scopes: OWNER_SCOPES as Scope[],
        tokenId: newTokenId(),
        expiresAt,
      });

      await deps.audit.emit({
        tenantId: cred.tenantId,
        layer: "identity",
        actor: cred.userId,
        action: "auth.login",
        inputs: { method: "password" },
        outputs: { user_id: cred.userId },
      });

      reply.status(200);
      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: deps.tokenTtlSeconds,
        principal: {
          id: cred.userId,
          type: "user",
          tenantId: cred.tenantId,
          scopes: OWNER_SCOPES,
        },
      };
    },
  );
}

/**
 * Production resolver: looks up a password-login user by email across tenants.
 * Uses the brain_privileged (BYPASSRLS) pool — login has no tenant context yet,
 * the same sanctioned cross-tenant entry point as the SIWX address→agent lookup.
 */
export class PostgresUserCredentialReader {
  public constructor(private readonly privilegedPool: Pool) {}

  public async resolveByEmail(email: string): Promise<UserCredential | null> {
    const { rows } = await this.privilegedPool.query<{
      id: string;
      tenant_id: string;
      status: string;
      password_hash: string | null;
    }>(
      `SELECT id, tenant_id, status, password_hash
         FROM users
        WHERE lower(email) = lower($1)
          AND password_hash IS NOT NULL
        LIMIT 1`,
      [email],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      userId: row.id,
      tenantId: row.tenant_id,
      status: row.status,
      passwordHash: row.password_hash,
    };
  }
}
