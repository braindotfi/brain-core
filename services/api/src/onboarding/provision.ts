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
import { contentHash, type PolicyDocument } from "@brain/policy";

/**
 * Batch 11: default agent-confidence floor for a freshly provisioned tenant.
 *
 * Confidence gating (RFC 0004 §5.2) is enforced mechanically in the §6 gate
 * via the policy VM, but it has been DORMANT BY DEFAULT: a new tenant with no
 * hand-written rules let document-extracted intents (capped at confidence
 * <= 0.5 at the agent_contributed write boundary) flow through at the 1.0
 * default. An operator who never ran `pnpm policy:bootstrap` was effectively
 * running without earned-autonomy. Opus 4.8 review P1-1.
 *
 * Tenants opt OUT (by re-signing an updated policy without this rule), not
 * in. The floor matches the agent-contributed write ceiling, so an intent
 * cited against an agent-contributed obligation will reject under this rule
 * until that obligation is corroborated upward (RFC 0004 §5.2 / persist.ts
 * counter-side check, batch 10 C-2).
 *
 * Rule shape: `applies_to: [any]`, `when: {agent.confidence.gte: 0.5}`,
 * `execute: auto`. The VM short-circuits on the FIRST matching rule (the
 * default-deny tail still applies when no rule matches), so a tenant policy
 * update that adds a more-permissive rule above this one supersedes the
 * floor without removing it. The policy is stored at version 1 in state
 * `active` so it is enforced from the first request.
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

export function buildDefaultPolicyDocument(floor = DEFAULT_CONFIDENCE_FLOOR): PolicyDocument {
  return {
    version: 1,
    rules: [
      {
        id: "default-agent-confidence-floor",
        applies_to: ["any"],
        when: { "agent.confidence.gte": floor },
        execute: "auto",
      },
    ],
  };
}

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

  const policyId = brainId(ID_PREFIX.policy);
  const defaultPolicy = buildDefaultPolicyDocument();
  const defaultPolicyHash = contentHash(defaultPolicy);

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
      // Batch 11: seed the default agent-confidence floor (Opus P1-1). State
      // = `active` so the §6 gate enforces it from the very first request;
      // version = 1 so a subsequent operator-signed policy increments cleanly.
      // The owner user is the `created_by`, which is the only user that
      // exists at this point in the tenant's lifecycle.
      await c.query(
        `INSERT INTO policies
           (id, tenant_id, version, content, content_hash, quorum_required, state, created_by, activated_at)
         VALUES ($1, $2, 1, $3, $4, 1, 'active', $5, now())`,
        [policyId, tenantId, JSON.stringify(defaultPolicy), defaultPolicyHash, userId],
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
