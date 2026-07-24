/**
 * Production fences for the DB-isolation env vars (Standards §1.2 / H-14).
 *
 *   BRAIN_WIKI_DB_URL   Wiki path MUST connect as brain_wiki_reader in
 *                       production so an accidental ledger_* write is a Postgres
 *                       permission error.
 *   BRAIN_MCP_READER_DB_URL
 *                       MCP raw evidence reads MUST connect as brain_mcp_reader
 *                       when raw.artifact.get is exposed.
 *   §4 role URLs        The cross-tenant workers/resolvers MUST each connect as
 *                       their own least-privilege BYPASSRLS role (replacing the
 *                       single broad brain_privileged). All eight are required
 *                       in production. See infra/db-roles.sql §4.
 *
 * In dev/test all of the wiki, MCP reader, and §4 worker URLs fall back to
 * the main pool with a warning. In production the absence of the wiki URL or
 * any §4 role URL throws (fail closed, these guard tenant isolation and
 * cross-tenant privilege boundaries). The MCP reader URL fails closed the
 * same way by default. BRAIN_ALLOW_MISSING_MCP_READER is the explicit
 * operator opt-out: when true, a missing MCP reader URL only warns and
 * degrades to raw.artifact.get being unavailable rather than blocking API
 * startup, since every consumer of that pool already fails closed
 * per-request instead (dependency_unavailable), so an operator who has
 * consciously accepted that gap can boot without the URL. Factored out of
 * main.ts so the behavior is unit-testable without booting the full server.
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
  /** The eight §4 role connection strings. */
  privilegedRoleUrls: PrivilegedRoleUrls;
  /** The tenant-scoped read-only MCP evidence role connection string. */
  mcpReaderDbUrl?: string | undefined;
  /**
   * Whether this process serves the Wiki (HTTP /v1). When false (a worker
   * process), BRAIN_WIKI_DB_URL is not required. Defaults to true (the api).
   */
  requireWiki?: boolean;
  /**
   * Whether this process serves MCP raw evidence reads. When false, the reader
   * URL is not required. Defaults to false.
   */
  requireMcpReader?: boolean;
  /**
   * Explicit operator opt-out (BRAIN_ALLOW_MISSING_MCP_READER) for the
   * fail-closed fence on the MCP reader URL. Defaults to false: a missing
   * URL throws in production, same as the wiki and §4 role URLs.
   */
  allowMissingMcpReader?: boolean;
  /**
   * Env var names of the role URLs this process actually needs (worker/process
   * separation): only these are fenced. When omitted, all are required (the
   * historical all-in-one process).
   */
  requiredEnv?: ReadonlySet<string>;
  /** Sink for non-fatal warnings; defaults to console.warn. Injectable for tests. */
  warn?: (msg: string) => void;
}

/**
 * Throws when production is missing the wiki URL, the MCP reader URL (unless
 * allowMissingMcpReader opts out), or a required §4 role URL. Returns the
 * list of warnings emitted (or empty in production-with-all-set). Only the
 * URLs this process role needs are fenced (see requireWiki / requiredEnv).
 */
export function assertDbIsolationFences(input: DbIsolationCheckInput): string[] {
  const warn = input.warn ?? ((m: string) => console.warn(m));
  const warnings: string[] = [];
  const isProd = input.nodeEnv === "production";
  const requireWiki = input.requireWiki ?? true;
  const requireMcpReader = input.requireMcpReader ?? false;
  const allowMissingMcpReader = input.allowMissingMcpReader ?? false;

  if (requireWiki && (input.wikiDbUrl === undefined || input.wikiDbUrl.length === 0)) {
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

  if (
    requireMcpReader &&
    (input.mcpReaderDbUrl === undefined || input.mcpReaderDbUrl.length === 0)
  ) {
    if (isProd && !allowMissingMcpReader) {
      throw new Error(
        "BRAIN_MCP_READER_DB_URL is required in NODE_ENV=production (H-14, Standards §1.2). " +
          "Set it to the brain_mcp_reader role connection string, or set " +
          "BRAIN_ALLOW_MISSING_MCP_READER=true to boot with raw.artifact.get disabled instead.",
      );
    }
    // allowMissingMcpReader (or dev/test): degrade gracefully rather than
    // fail closed. Every consumer of the MCP reader pool (raw.artifact.get)
    // already treats an absent pool as `dependency_unavailable` at request time
    // (services/mcp/src/tools/types.ts requireToolService), so this keeps the
    // blast radius scoped to that one tool for an operator who opted in.
    const msg = "[boot] BRAIN_MCP_READER_DB_URL unset. raw.artifact.get will be unavailable.";
    warn(msg);
    warnings.push(msg);
  }

  for (const [name, url] of Object.entries(input.privilegedRoleUrls)) {
    if (input.requiredEnv !== undefined && !input.requiredEnv.has(name)) continue;
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
