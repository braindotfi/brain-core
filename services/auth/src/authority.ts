/**
 * The authority model (AUTH-PATHS-PLAN.md section 1):
 *
 *   users row (status='active', email_verified_at NOT NULL)
 *     -> members WHERE tenant_id = users.tenant_id AND id = users.id
 *     -> require status='active' AND role='admin'
 *
 * `users` is the authentication principal; `members` is the authority. They
 * are linked by `id` EQUALITY, not a column -- every creation site (self-serve
 * signup, production tenant founder, invite consume) writes the same id into
 * both tables. Do NOT add `members.user_id`: legitimate member rows exist
 * with no user (invited-but-not-consumed, demo seed rows, bootstrap
 * placeholders), and a nullable FK would only duplicate what `id` already
 * carries.
 *
 * Fails closed on a missing, inactive, or non-admin member row. No fallback
 * to `users.role='owner'` -- that is a second authority model this function
 * exists to prevent. `members.role` has no `owner` value (CHECK is
 * admin|approver|viewer); every owner-user's member row is `admin` in
 * practice, so requiring role='admin' covers owners without a second branch.
 *
 * This resolves AUTHORITY, separately from AUTHENTICATION: a human can
 * authenticate at /login (valid email + password + verified email) while
 * still being refused authority here (no member row, a deactivated member
 * row, or a non-admin role). Nothing in this increment gates /login on this
 * function -- it exists for a future consent flow (Phase 2a's /authorize)
 * and is tested standalone.
 */

import type { Pool } from "pg";
import { withTenantScope, type TenantScopedClient } from "@brain/shared";

export interface AuthorityGrant {
  readonly tenantId: string;
  readonly memberId: string;
}

export type AuthorityResult =
  | { readonly ok: true; readonly grant: AuthorityGrant }
  | { readonly ok: false; readonly reason: "member_missing" | "member_inactive" | "not_admin" };

interface MemberAuthorityRow {
  readonly id: string;
  readonly status: string;
  readonly role: string;
}

export async function resolveAuthority(
  pool: Pool,
  input: { readonly tenantId: string; readonly userId: string },
): Promise<AuthorityResult> {
  return withTenantScope(pool, input.tenantId, async (client: TenantScopedClient) => {
    const { rows } = await client.query<MemberAuthorityRow>(
      `SELECT id, status, role FROM members WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [input.tenantId, input.userId],
    );
    const row = rows[0];
    if (row === undefined) return { ok: false, reason: "member_missing" };
    if (row.status !== "active") return { ok: false, reason: "member_inactive" };
    if (row.role !== "admin") return { ok: false, reason: "not_admin" };
    return { ok: true, grant: { tenantId: input.tenantId, memberId: row.id } };
  });
}
