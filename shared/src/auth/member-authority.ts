/**
 * Shared member-authority check.
 *
 * Scopes on a bearer token are a snapshot taken at mint time (session
 * exchange, refresh, or invite consume). They are NOT re-derived from the
 * `members` row on every request, so a token can keep carrying a scope the
 * member's role no longer justifies -- most obviously right after an admin
 * demotes or deactivates someone, but also for any route that (bug or not)
 * hands out a broader scope set than the member's role should carry.
 *
 * Routes that mutate tenant-level state (agent kill-switch, API key
 * issuance/revocation, tenant deletion, tenant export) must not trust the
 * scope alone for that reason. This mirrors the DB-backed role recheck
 * `requireAdmin` already does in services/execution/src/members/routes.ts,
 * generalized so any service with a Pool can call it without depending on
 * that service's repository types.
 */

import type { Pool } from "pg";
import { brainError } from "../errors.js";
import { withTenantScope } from "../db/tenant-scoped.js";

export type MemberAuthorityRole = "admin" | "approver" | "viewer";
export type MemberAuthorityStatus = "invited" | "active" | "deactivated";

export interface MemberAuthorityRow {
  id: string;
  tenantId: string;
  role: MemberAuthorityRole;
  active: boolean;
  status: MemberAuthorityStatus;
}

/**
 * Re-reads the caller's `members` row and throws unless it is active and
 * `role = 'admin'`. Callers must already have established that the principal
 * is `type=user` and bound to `tenantId` -- this only re-checks authority,
 * not identity.
 */
export async function requireAdminMember(
  pool: Pool,
  tenantId: string,
  memberId: string,
): Promise<MemberAuthorityRow> {
  const member = await withTenantScope(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      role: MemberAuthorityRole;
      active: boolean;
      status: MemberAuthorityStatus;
    }>(
      `SELECT id, tenant_id, role, active, status
         FROM members
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [memberId, tenantId],
    );
    return rows[0] ?? null;
  });
  if (member === null || !member.active || member.status !== "active") {
    throw brainError("payment_intent_approval_invalid", "actor_unresolved", {
      statusOverride: 403,
      details: { reason: "actor_unresolved" },
    });
  }
  if (member.role !== "admin") {
    throw brainError("auth_scope_insufficient", "admin member required", {
      details: { reason: "admin_member_required" },
    });
  }
  return {
    id: member.id,
    tenantId: member.tenant_id,
    role: member.role,
    active: member.active,
    status: member.status,
  };
}
