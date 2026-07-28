/**
 * Two DB pools for the OAuth authorization server's human-auth routes
 * (AUTH-PATHS-PLAN.md, "Wire the AS to the database").
 *
 *  - authPool: brain_auth (NOBYPASSRLS). Tenant-scoped reads/writes through
 *    withTenantScope, used once a tenant_id is already known (the
 *    set-password `?tid=` param, or a resolved login).
 *  - resolverPool: brain_resolver (BYPASSRLS). The one sanctioned
 *    cross-tenant reader, for the email -> user lookup at /login and
 *    /forgot-password before any tenant context exists. brain_auth cannot do
 *    this itself: it is NOBYPASSRLS, so with no app.tenant_id set, RLS
 *    silently returns zero rows rather than erroring -- the gap the
 *    increment-1 oauth migration header (0001_oauth_clients_and_grants.sql)
 *    records and defers to this file.
 *
 * Same fail-closed-in-production / fall-back-to-DATABASE_URL-in-dev posture
 * as every other least-privilege role URL in
 * services/api/src/composition/db-isolation.ts -- not a stricter rule
 * invented for this service.
 */

import { createPool } from "@brain/shared";
import type { Pool } from "pg";

export interface AuthDbPools {
  readonly authPool: Pool;
  readonly resolverPool: Pool;
  readonly auditPool: Pool;
}

export type AuthRoleUrlName =
  | "BRAIN_AUTH_DB_URL"
  | "BRAIN_RESOLVER_DB_URL"
  | "BRAIN_AUTH_AUDIT_DB_URL";

export interface AuthDbPoolsInput {
  readonly nodeEnv: string;
  readonly authDbUrl: string | undefined;
  readonly resolverDbUrl: string | undefined;
  readonly auditDbUrl: string | undefined;
  /** Dev/test fallback only -- never used to silently satisfy production. */
  readonly databaseUrl: string;
  readonly serviceName: string;
  readonly statementTimeoutMs: number;
  /** Sink for non-fatal warnings; defaults to console.warn. Injectable for tests. */
  readonly warn?: (msg: string) => void;
}

export function resolveRoleUrl(
  name: AuthRoleUrlName,
  url: string | undefined,
  input: Pick<AuthDbPoolsInput, "nodeEnv" | "databaseUrl" | "warn">,
): string {
  if (url !== undefined && url.length > 0) return url;
  if (input.nodeEnv === "production") {
    throw new Error(
      `[auth] ${name} is required in NODE_ENV=production (AUTH-PATHS-PLAN.md). ` +
        "A public browser-facing origin must not fall back to a broader role.",
    );
  }
  const warn = input.warn ?? ((m: string) => console.warn(m));
  warn(`[auth] ${name} unset -- falls back to DATABASE_URL (dev/test only).`);
  return input.databaseUrl;
}

export function buildAuthDbPools(input: AuthDbPoolsInput): AuthDbPools {
  const authDbUrl = resolveRoleUrl("BRAIN_AUTH_DB_URL", input.authDbUrl, input);
  const resolverDbUrl = resolveRoleUrl("BRAIN_RESOLVER_DB_URL", input.resolverDbUrl, input);
  const auditDbUrl = resolveRoleUrl("BRAIN_AUTH_AUDIT_DB_URL", input.auditDbUrl, input);
  return {
    authPool: createPool({
      connectionString: authDbUrl,
      applicationName: `${input.serviceName}-auth`,
      statementTimeoutMs: input.statementTimeoutMs,
    }),
    resolverPool: createPool({
      connectionString: resolverDbUrl,
      applicationName: `${input.serviceName}-resolver`,
      statementTimeoutMs: input.statementTimeoutMs,
    }),
    auditPool: createPool({
      connectionString: auditDbUrl,
      applicationName: `${input.serviceName}-audit`,
      statementTimeoutMs: input.statementTimeoutMs,
    }),
  };
}
