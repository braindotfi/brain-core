/**
 * Production fences for the DB-isolation env vars (Standards §1.2 / H-14).
 *
 *   BRAIN_WIKI_DB_URL        Wiki path MUST connect as brain_wiki_reader in
 *                            production so an accidental ledger_* write is a
 *                            Postgres permission error.
 *   DATABASE_PRIVILEGED_URL  Outbox worker + tenant-deletion service do
 *                            cross-tenant work; in production they MUST use
 *                            brain_privileged (BYPASSRLS).
 *
 * In dev/test both fall back to the main pool with a warning. In production
 * the absence of either throws. Factored out of main.ts so the behavior is
 * unit-testable without booting the full server.
 */

export interface DbIsolationCheckInput {
  nodeEnv: string | undefined;
  wikiDbUrl: string | undefined;
  privilegedDbUrl: string | undefined;
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

  if (input.wikiDbUrl === undefined || input.wikiDbUrl.length === 0) {
    if (input.nodeEnv === "production") {
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

  if (input.privilegedDbUrl === undefined || input.privilegedDbUrl.length === 0) {
    if (input.nodeEnv === "production") {
      throw new Error(
        "DATABASE_PRIVILEGED_URL is required in NODE_ENV=production (Standards §1.2). " +
          "Set it to the brain_privileged role connection string.",
      );
    }
    const msg =
      "[boot] DATABASE_PRIVILEGED_URL unset — outbox worker uses DATABASE_URL (dev/testnet only).";
    warn(msg);
    warnings.push(msg);
  }

  return warnings;
}
