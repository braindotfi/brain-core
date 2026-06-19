/**
 * Production fences for the DB-isolation env vars (Standards §1.2 / H-14).
 *
 *   BRAIN_WIKI_DB_URL   Wiki path MUST connect as brain_wiki_reader in
 *                       production so an accidental ledger_* write is a Postgres
 *                       permission error.
 *   §4 role URLs        The cross-tenant workers/resolvers MUST each connect as
 *                       their own least-privilege BYPASSRLS role (replacing the
 *                       single broad brain_privileged). All eight are required
 *                       in production. See infra/db-roles.sql §4.
 *
 * In dev/test each falls back to the main pool with a warning. In production the
 * absence of any throws. Factored out of main.ts so the behavior is
 * unit-testable without booting the full server.
 */

/** The eight §4 least-privilege role URLs, keyed by env var name. */
export interface PrivilegedRoleUrls {
  BRAIN_RAW_WORKER_DB_URL: string | undefined;
  BRAIN_CANONICAL_PROJECTOR_DB_URL: string | undefined;
  BRAIN_LEDGER_PROJECTOR_DB_URL: string | undefined;
  BRAIN_EXECUTION_WORKER_DB_URL: string | undefined;
  BRAIN_AUDIT_VERIFIER_DB_URL: string | undefined;
  BRAIN_AUDIT_PUBLISHER_DB_URL: string | undefined;
  BRAIN_RESOLVER_DB_URL: string | undefined;
  BRAIN_TENANT_DELETION_DB_URL: string | undefined;
}

export interface DbIsolationCheckInput {
  nodeEnv: string | undefined;
  wikiDbUrl: string | undefined;
  /** The seven §4 role connection strings. */
  privilegedRoleUrls: PrivilegedRoleUrls;
  /** Sink for non-fatal warnings; defaults to console.warn. Injectable for tests. */
  warn?: (msg: string) => void;
}

/**
 * Throws when production is missing a required isolation URL. Returns the
 * list of warnings emitted (or empty in production-with-all-set).
 */
export function assertDbIsolationFences(input: DbIsolationCheckInput): string[] {
  const warn = input.warn ?? ((m: string) => console.warn(m));
  const warnings: string[] = [];
  const isProd = input.nodeEnv === "production";

  if (input.wikiDbUrl === undefined || input.wikiDbUrl.length === 0) {
    if (isProd) {
      throw new Error(
        "BRAIN_WIKI_DB_URL is required in NODE_ENV=production (H-14, Standards §1.2). " +
          "Set it to the brain_wiki_reader role connection string.",
      );
    }
    const msg =
      "[boot] BRAIN_WIKI_DB_URL unset — Wiki shares the main DATABASE_URL (full privileges). " +
      "Set it to the brain_wiki_reader role in production (H-14).";
    warn(msg);
    warnings.push(msg);
  }

  for (const [name, url] of Object.entries(input.privilegedRoleUrls)) {
    if (url !== undefined && url.length > 0) continue;
    if (isProd) {
      throw new Error(
        `${name} is required in NODE_ENV=production (Standards §1.2). ` +
          "Set it to the matching least-privilege role connection string (infra/db-roles.sql §4).",
      );
    }
    const msg = `[boot] ${name} unset — falls back to DATABASE_URL (dev/testnet only).`;
    warn(msg);
    warnings.push(msg);
  }

  return warnings;
}
