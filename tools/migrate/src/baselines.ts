/**
 * Declared migration baselines.
 *
 * A baseline is an in-repo, reviewed exception for a migration that cannot be
 * RUN on some supported database platform, but whose end state can be PROVEN
 * to already hold there by a SQL guard. When both are true, the runner may
 * record the migration as applied (with its real content hash) instead of
 * executing its SQL.
 *
 * Adding an entry here is legitimate only when both of the following hold:
 *
 *   1. The migration's desired end state is ALREADY TRUE on the target
 *      database, established some other way (typically an earlier migration
 *      that reaches the same state through a code path the platform does
 *      accept).
 *   2. The migration's own SQL cannot run on that platform (a managed service
 *      rejects a specific statement, a permission the platform withholds,
 *      etc.), so there is no way to make it apply normally.
 *
 * A baseline is never a way to skip work that still needs doing. The guard
 * must be a precise, narrow assertion of the migration's actual end state,
 * not a loose "probably fine" check, and it must return FALSE (not merely
 * zero rows or an error) when that end state does not hold, so the runner
 * falls through to applying the migration for real and failing loudly where
 * a human genuinely has to decide.
 *
 * services/ledger/migrations/0049_pgcrypto_public_schema.sql runs:
 *
 *   CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
 *   ALTER EXTENSION pgcrypto SET SCHEMA public;
 *
 * Azure Database for PostgreSQL Flexible Server rejects the second statement
 * outright ("SET SCHEMA clause for ALTER EXTENSION is not supported"), so the
 * migration can never apply there and it blocks every later migration.
 * Self-hosted Postgres allows it.
 *
 * The migration exists to rescue databases where pgcrypto landed in an
 * isolated test schema. On any normal database, migration
 * 0031_pgcrypto_extension.sql has already created pgcrypto in `public` via
 * search_path, so 0049's desired end state ALREADY HOLDS there and only the
 * unsupported ALTER statement is in the way.
 */

export interface MigrationBaseline {
  /** Migration key, `{service}/{filename}`. */
  key: string;
  /** Why this migration cannot run in some supported environment. */
  reason: string;
  /**
   * SQL returning a single boolean column `ok`. TRUE means the migration's
   * end state already holds and it can be recorded as applied without
   * running. Must be total: FALSE (not zero rows) when the end state does
   * not hold.
   */
  guard: string;
}

export const MIGRATION_BASELINES: ReadonlyArray<MigrationBaseline> = [
  {
    key: "ledger/0049_pgcrypto_public_schema.sql",
    reason:
      "Azure Database for PostgreSQL Flexible Server rejects " +
      'ALTER EXTENSION pgcrypto SET SCHEMA public ("SET SCHEMA clause for ' +
      'ALTER EXTENSION is not supported"). Migration 0031 already creates ' +
      "pgcrypto in public on any normal database, so this migration's end " +
      "state already holds there and only the unsupported statement blocks it.",
    guard: `
      SELECT EXISTS (
        SELECT 1 FROM pg_extension
         WHERE extname = 'pgcrypto'
           AND extnamespace::regnamespace::text = 'public'
      ) AS ok
    `,
  },
];
