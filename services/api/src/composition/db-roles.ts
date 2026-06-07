/**
 * Boot-time DB role verification (Codex c96283d P2).
 *
 * `db-isolation.ts` fences that the isolation URLs are SET, but a URL's presence
 * does not prove it connects with the intended role. This queries each pool's
 * actual role and asserts its RLS posture:
 *
 *   - the request pool (brain_app) and the wiki pool (brain_wiki_reader) must
 *     NOT be BYPASSRLS and must not be a superuser (a superuser bypasses RLS
 *     unconditionally, defeating tenant isolation);
 *   - the privileged pool (brain_privileged) MUST be BYPASSRLS so its sanctioned
 *     cross-tenant jobs (audit emitter, anchoring, consistency verifier) can see
 *     every tenant.
 *
 * In production a mismatch throws (fail-closed boot). In dev/test, where all
 * three pools alias one possibly-superuser connection, it only logs the observed
 * identities so the operator can see the runtime capabilities.
 */

export interface RoleIdentity {
  current_user: string;
  session_user: string;
  rolbypassrls: boolean;
  rolsuper: boolean;
}

export interface PoolRoleExpectation {
  /** "request" | "privileged" | "wiki" — used in messages. */
  label: string;
  pool: { query: (sql: string) => Promise<{ rows: RoleIdentity[] }> };
  /** privileged → true; request/wiki → false. */
  mustBypassRls: boolean;
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
    const res = await p.pool.query(ROLE_QUERY);
    const id = res.rows[0];
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
  }

  if (violations.length > 0 && opts.enforce) {
    throw new Error(
      `DB role verification failed (Codex c96283d P2):\n  - ${violations.join("\n  - ")}`,
    );
  }
  return { identities, violations };
}
