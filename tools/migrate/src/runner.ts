/**
 * Brain migration runner.
 *
 * Applies discovered migrations serially, tracking applied ones in
 * `brain_migrations`. Each migration runs inside its own transaction. A
 * failing migration rolls back and stops the run — no attempt to reconcile
 * partial application.
 *
 * Schema of `brain_migrations` (created on first run):
 *   CREATE TABLE brain_migrations (
 *     key         TEXT PRIMARY KEY,     -- `{service}/{filename}`
 *     service     TEXT NOT NULL,
 *     name        TEXT NOT NULL,
 *     sequence    TEXT NOT NULL,
 *     content_sha BYTEA NOT NULL,       -- sha256 of the SQL as-applied
 *     applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     applied_by  TEXT NOT NULL         -- the CLI user (env USER / $USER)
 *   )
 *
 * Replaying an already-applied migration with *changed* content raises an
 * error rather than silently re-running. That is how we enforce §10.5's
 * "migrations are forward-compatible for at least one version" — operators
 * can't mutate an applied migration in place.
 */

import { createHash } from "node:crypto";
import type { Client, PoolClient } from "pg";
import type { DiscoveredMigration } from "./discover.js";

export interface MigrationRecord {
  key: string;
  service: string;
  name: string;
  sequence: string;
  content_sha: Buffer;
  applied_at: Date;
  applied_by: string;
}

export interface RunResult {
  applied: DiscoveredMigration[];
  skipped: DiscoveredMigration[];
}

/**
 * Minimal client shape we need — accepts either `pg.Client` or `pg.PoolClient`.
 * Keeps the runner decoupled from how the caller obtained a connection.
 */
export interface RunnerClient {
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: TRow[]; rowCount: number | null }>;
}

export function contentSha(sql: string): Buffer {
  return createHash("sha256").update(sql, "utf8").digest();
}

/**
 * Stable advisory-lock key for the migration runner. `hashtext` maps the
 * label to the int4 that `pg_advisory_lock(bigint)` consumes; every caller
 * computes the same key, so concurrent runners serialize on it.
 */
const MIGRATION_LOCK_EXPR = "hashtext('brain_migrations')";

/**
 * Acquire the session-level migration advisory lock. Blocks until granted, so
 * concurrent runners (e.g. parallel integration-test schemas) apply migrations
 * one at a time instead of racing global DDL such as role/grant statements
 * (`tuple concurrently updated`). Must be released on the same connection.
 */
export async function acquireMigrationLock(client: RunnerClient): Promise<void> {
  await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_EXPR})`);
}

/** Release the session-level migration advisory lock acquired above. */
export async function releaseMigrationLock(client: RunnerClient): Promise<void> {
  await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_EXPR})`);
}

/** Ensures the `brain_migrations` bookkeeping table exists. Idempotent. */
export async function ensureBookkeeping(client: RunnerClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS brain_migrations (
      key         TEXT PRIMARY KEY,
      service     TEXT NOT NULL,
      name        TEXT NOT NULL,
      sequence    TEXT NOT NULL,
      content_sha BYTEA NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by  TEXT NOT NULL
    );
  `);
}

export async function listApplied(client: RunnerClient): Promise<Map<string, MigrationRecord>> {
  const { rows } = await client.query<MigrationRecord>(
    `SELECT key, service, name, sequence, content_sha, applied_at, applied_by
       FROM brain_migrations
      ORDER BY key`,
  );
  const map = new Map<string, MigrationRecord>();
  for (const r of rows) map.set(r.key, r);
  return map;
}

/**
 * Apply pending migrations. Returns the ones applied and the ones skipped
 * (already present with matching content hash).
 *
 * If a discovered migration's content hash does NOT match the stored one,
 * the runner throws — a human must reconcile before forward progress.
 */
export async function applyAll(
  client: RunnerClient & Pick<PoolClient, "query"> & Partial<Pick<Client, "connect">>,
  discovered: ReadonlyArray<DiscoveredMigration>,
  options: { appliedBy?: string } = {},
): Promise<RunResult> {
  const appliedBy = options.appliedBy ?? process.env.USER ?? "unknown";

  // Serialize the whole apply pass behind a session advisory lock. Migrations
  // include global DDL (role/grant) that races under concurrent runners; the
  // lock makes accidental concurrent invocations safe even outside CI.
  await acquireMigrationLock(client);
  try {
    await ensureBookkeeping(client);
    const applied = await listApplied(client);

    const result: RunResult = { applied: [], skipped: [] };

    for (const m of discovered) {
      const seen = applied.get(m.key);
      const sha = contentSha(m.sql);
      if (seen !== undefined) {
        if (!bufferEquals(seen.content_sha, sha)) {
          throw new Error(
            `migration ${m.key} previously applied with a different content hash; ` +
              `applied sha=${toHex(seen.content_sha)} discovered sha=${toHex(sha)}`,
          );
        }
        result.skipped.push(m);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO brain_migrations
             (key, service, name, sequence, content_sha, applied_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [m.key, m.service, m.name, m.sequence, sha, appliedBy],
        );
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* swallow */
        }
        throw new Error(
          `migration ${m.key} failed: ${err instanceof Error ? err.message : String(err)}`,
          {
            cause: err instanceof Error ? err : undefined,
          },
        );
      }
      result.applied.push(m);
    }

    return result;
  } finally {
    try {
      await releaseMigrationLock(client);
    } catch {
      /* best-effort: the lock is released on connection close regardless */
    }
  }
}

export async function status(
  client: RunnerClient,
  discovered: ReadonlyArray<DiscoveredMigration>,
): Promise<Array<{ migration: DiscoveredMigration; state: "pending" | "applied" | "drifted" }>> {
  await ensureBookkeeping(client);
  const applied = await listApplied(client);
  return discovered.map((m) => {
    const seen = applied.get(m.key);
    if (seen === undefined) return { migration: m, state: "pending" as const };
    const match = bufferEquals(seen.content_sha, contentSha(m.sql));
    return { migration: m, state: match ? ("applied" as const) : ("drifted" as const) };
  });
}

function bufferEquals(a: Buffer | ReadonlyArray<number> | Uint8Array, b: Buffer): boolean {
  const aBuf = Buffer.isBuffer(a) ? a : Buffer.from(a as Uint8Array);
  if (aBuf.length !== b.length) return false;
  return aBuf.equals(b);
}

function toHex(buf: Buffer | ReadonlyArray<number> | Uint8Array): string {
  return Buffer.isBuffer(buf)
    ? buf.toString("hex")
    : Buffer.from(buf as Uint8Array).toString("hex");
}
