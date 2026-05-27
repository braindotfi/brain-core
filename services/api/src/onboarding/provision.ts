/**
 * Self-serve tenant provisioning — RFC 0002 Phase B (decision A: api owns the
 * evolving identity schema; execution keeps reading `users` for resolveRole).
 *
 * `provisionTenant` atomically creates a brand-new **sandbox** tenant, its owner
 * user (email + scrypt password hash, status `pending`), and a single-use
 * email-verification token, then returns the new ids. It is the only path that
 * creates a tenant.
 *
 * Isolation (the safety crux): a FRESH tenant id is minted *here* and used as the
 * RLS scope (`withTenantScope`); every INSERT is keyed to that id. The caller
 * cannot supply or influence the tenant id, so this path can only ever create
 * rows for the new tenant — it is NOT a cross-tenant writer. The RLS write
 * policies (`id = app.tenant_id` / `tenant_id = app.tenant_id`) pass for exactly
 * the new tenant; a global unique index on `lower(email)` (enforced beneath RLS)
 * rejects a duplicate email even across tenants → `signup_email_taken`.
 *
 * This module performs NO money movement and grants NO execution capability. The
 * tenant is `sandbox = TRUE`; promotion to a live, money-moving tenant remains the
 * existing human-gated step (H-24 + external audit).
 */

import type { Pool } from "pg";
import {
  brainError,
  brainId,
  ID_PREFIX,
  withTenantScope,
  type TenantScopedClient,
} from "@brain/shared";

export interface ProvisionTenantInput {
  /** Owner email (caller normalizes/validates; stored as given). */
  readonly email: string;
  /** Serialized scrypt hash from `hashPassword` (never the plaintext). */
  readonly passwordHash: string;
  /** sha256 of the raw verification token; the raw token is only ever emailed. */
  readonly emailVerificationTokenHash: string;
  /** Expiry for the verification token. */
  readonly emailVerificationExpiresAt: Date;
}

export interface ProvisionedTenant {
  readonly tenantId: string;
  readonly userId: string;
}

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Provision a new sandbox tenant + owner user + email-verification token,
 * atomically. Throws `signup_email_taken` (409) when the email already has a
 * password-login account (anywhere); rethrows anything else after rollback.
 */
export async function provisionTenant(
  pool: Pool,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  const tenantId = brainId(ID_PREFIX.tenant);
  const userId = brainId(ID_PREFIX.user);

  try {
    await withTenantScope(pool, tenantId, async (c: TenantScopedClient) => {
      await c.query(
        "INSERT INTO tenants (id, sandbox, created_via) VALUES ($1, TRUE, 'self_serve')",
        [tenantId],
      );
      await c.query(
        `INSERT INTO users (id, tenant_id, email, role, password_hash, status)
         VALUES ($1, $2, $3, 'owner', $4, 'pending')`,
        [userId, tenantId, input.email, input.passwordHash],
      );
      await c.query(
        `INSERT INTO email_verifications (token_hash, user_id, tenant_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [input.emailVerificationTokenHash, userId, tenantId, input.emailVerificationExpiresAt],
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw brainError("signup_email_taken", "an account with this email already exists");
    }
    throw err;
  }

  return { tenantId, userId };
}
