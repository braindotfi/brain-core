/**
 * Boot-time DB role verification (Codex c96283d P2, extended by fca9ac8 P2 #4).
 *
 * `db-isolation.ts` fences that the isolation URLs are SET, but a URL's presence
 * does not prove it connects with the intended role. This queries each pool's
 * actual role and asserts:
 *
 *   - RLS posture: the request (brain_app) and wiki (brain_wiki_reader) pools
 *     must NOT be BYPASSRLS and must not be a superuser; the privileged
 *     (brain_privileged) pool MUST be BYPASSRLS;
 *   - role IDENTITY: each pool connects as its EXPECTED role name, so a swapped
 *     request/wiki URL (both NOBYPASSRLS, so the posture check alone can't tell
 *     them apart) is caught;
 *   - representative permissions: a role must NOT hold privileges it should never
 *     have (e.g. the wiki reader must not be able to write Ledger tables).
 *
 * In production a mismatch throws (fail-closed boot). In dev/test, where all
 * three pools alias one possibly-superuser connection, it only logs the observed
 * identities.
 */

export interface RoleIdentity {
  current_user: string;
  session_user: string;
  rolbypassrls: boolean;
  rolsuper: boolean;
}

export type RoleQuery = (
  sql: string,
  params?: ReadonlyArray<unknown>,
) => Promise<{ rows: ReadonlyArray<unknown> }>;

export interface PoolRoleExpectation {
  /** "request" | "privileged" | "wiki" — used in messages. */
  label: string;
  query: RoleQuery;
  /** privileged → true; request/wiki → false. */
  mustBypassRls: boolean;
  /** Exact role name this pool must connect as (catches a swapped URL). */
  expectedRole?: string;
  /** Privileges the role must NOT hold (defense-in-depth against a swapped URL). */
  forbidden?: ReadonlyArray<{ table: string; privilege: string }>;
}

export interface AssertDbRolesOptions {
  /** Throw on a violation (production). When false, violations are returned only. */
  enforce: boolean;
  /** Structured log sink for the observed identities (brain.runtime.capabilities). */
  log?: (msg: string, ctx: Record<string, unknown>) => void;
}

export interface DbRolesResult {
  identities: Array<{ label: string } & RoleIdentity>;
  violations: string[];
}

const ROLE_QUERY = `SELECT current_user, session_user, r.rolbypassrls, r.rolsuper
   FROM pg_roles r WHERE r.rolname = current_user`;

export async function assertDbRoles(
  pools: ReadonlyArray<PoolRoleExpectation>,
  opts: AssertDbRolesOptions,
): Promise<DbRolesResult> {
  const identities: DbRolesResult["identities"] = [];
  const violations: string[] = [];

  for (const p of pools) {
    const res = await p.query(ROLE_QUERY);
    const id = res.rows[0] as RoleIdentity | undefined;
    if (id === undefined) {
      violations.push(`${p.label}: could not resolve the current_user role from pg_roles`);
      continue;
    }
    identities.push({ label: p.label, ...id });
    opts.log?.("[boot] db role verified", { pool: p.label, ...id });

    // A superuser bypasses RLS unconditionally — never acceptable for any pool.
    if (id.rolsuper) {
      violations.push(`${p.label} connects as a SUPERUSER (${id.current_user}); RLS is bypassed`);
    }
    if (p.mustBypassRls && !id.rolbypassrls) {
      violations.push(
        `${p.label} must be BYPASSRLS (brain_privileged) but ${id.current_user} is not`,
      );
    }
    if (!p.mustBypassRls && id.rolbypassrls) {
      violations.push(
        `${p.label} must NOT be BYPASSRLS but ${id.current_user} is — tenant isolation defeated`,
      );
    }
    // Role identity: catches a swapped URL even when RLS posture matches.
    if (p.expectedRole !== undefined && id.current_user !== p.expectedRole) {
      violations.push(
        `${p.label} must connect as ${p.expectedRole} but connected as ${id.current_user} (swapped URL?)`,
      );
    }
    // Representative forbidden privileges.
    for (const f of p.forbidden ?? []) {
      const pr = await p.query(`SELECT has_table_privilege(current_user, $1, $2) AS has`, [
        f.table,
        f.privilege,
      ]);
      if ((pr.rows[0] as { has?: unknown } | undefined)?.has === true) {
        violations.push(
          `${p.label} (${id.current_user}) must NOT have ${f.privilege} on ${f.table} but does`,
        );
      }
    }
  }

  if (violations.length > 0 && opts.enforce) {
    throw new Error(
      `DB role verification failed (Codex c96283d P2 / fca9ac8 P2 #4):\n  - ${violations.join("\n  - ")}`,
    );
  }
  return { identities, violations };
}
