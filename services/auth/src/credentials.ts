/**
 * Cross-tenant email -> user lookup for /login and /forgot-password, before
 * any tenant context exists. Mirrors PostgresUserCredentialReader
 * (services/api/src/onboarding/login.ts), but through the AS's own
 * brain_resolver pool -- the sanctioned cross-tenant reader (BYPASSRLS) --
 * rather than api's. brain_auth (NOBYPASSRLS) cannot do this lookup: with no
 * app.tenant_id set, RLS silently returns zero rows.
 */

import type { Pool } from "pg";

export interface AuthUserCredential {
  readonly userId: string;
  readonly tenantId: string;
  readonly status: string;
  readonly emailVerifiedAt: Date | null;
  readonly passwordHash: string | null;
}

/** The narrow surface routes/human-auth.ts depends on -- lets route tests inject a fake. */
export interface UserCredentialReader {
  resolveByEmail(email: string): Promise<AuthUserCredential | null>;
  resolveAnyByEmail(email: string): Promise<AuthUserCredential | null>;
}

interface UserCredentialRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly email_verified_at: Date | null;
  readonly password_hash: string | null;
}

export class ResolverUserCredentialReader {
  public constructor(private readonly resolverPool: Pool) {}

  /** For /login: only a user who already has a password can ever verify. */
  public async resolveByEmail(email: string): Promise<AuthUserCredential | null> {
    return this.query("AND password_hash IS NOT NULL", email);
  }

  /**
   * For /forgot-password: deliberately does NOT filter on password_hash --
   * a founder or invited colleague who never set one yet is exactly who
   * /forgot-password must be able to (re)send a set-password link to.
   */
  public async resolveAnyByEmail(email: string): Promise<AuthUserCredential | null> {
    return this.query("", email);
  }

  private async query(extraWhere: string, email: string): Promise<AuthUserCredential | null> {
    // `users_tenant_id_email_key` is per-tenant, so the same email can
    // legitimately exist in N tenants' rows. LIMIT 1 with no ORDER BY picks
    // an arbitrary, Postgres-plan-dependent row (finding 6). ORDER BY
    // created_at ASC, id ASC (a stable tiebreaker -- Brain ULIDs are
    // lexicographically time-ordered too, so id ASC alone would almost
    // always agree, but created_at is the explicit, readable intent) always
    // picks the SAME row for a given email: the earliest-created account.
    //
    // Product limitation to escalate, not papered over here: because this is
    // the ONLY token-minting path (POST /forgot-password) in this router, a
    // person who legitimately holds accounts in two tenants under the same
    // email can only ever complete self-serve password reset for the
    // earliest-created one. The other tenant's account can never receive a
    // token through this flow at all (this query always resolves to the same
    // row), and if it ever received one through a different path (e.g. a
    // future invite flow), consumeSetPasswordToken would hit the GLOBAL
    // `users_login_email_unique` unique violation this file's header
    // documents once the first account has a password.
    const { rows } = await this.resolverPool.query<UserCredentialRow>(
      `SELECT id, tenant_id, status, email_verified_at, password_hash
         FROM users
        WHERE lower(email) = lower($1)
          ${extraWhere}
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [email],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      userId: row.id,
      tenantId: row.tenant_id,
      status: row.status,
      emailVerifiedAt: row.email_verified_at,
      passwordHash: row.password_hash,
    };
  }
}
