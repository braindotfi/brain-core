/**
 * Brain tenant-scoped DB helper.
 *
 * §1 principle 2: "Tenant isolation at the storage layer, not the query layer.
 * Row-level security on every Postgres table. [...] Shared-query-with-filter
 * is not an acceptable pattern for tenant-scoped data."
 *
 * Every table with tenant data has an RLS policy of the form:
 *
 *     CREATE POLICY tenant_isolation ON <table>
 *       USING (tenant_id = current_setting('app.tenant_id')::uuid);
 *
 * Application code NEVER touches `tenant_id` in WHERE clauses. Instead, every
 * query runs inside a `withTenantScope(pool, tenantId, fn)` block that:
 *
 *   1. Checks out a dedicated client from the pool.
 *   2. BEGINs a transaction.
 *   3. Executes `SET LOCAL app.tenant_id = $1` with the Brain tenant id.
 *   4. Runs the caller-supplied `fn(client)` inside the transaction.
 *   5. COMMITs on success, ROLLBACKs on throw, releases the client.
 *
 * SET LOCAL is transaction-scoped — it CANNOT leak across requests. That is
 * the storage-layer guarantee §1 requires.
 *
 * A caller who needs cross-tenant operations (platform admin, migrations)
 * must bypass this helper explicitly and go through a privileged DB role
 * that has BYPASSRLS. That role is not available to the request-path user.
 */

import type { Pool, PoolClient } from "pg";
import { brainError } from "../errors.js";
import { isBrainId } from "../ids.js";

/** Minimal shape callers see; hides pg.PoolClient internals we don't expose. */
export interface TenantScopedClient {
  query<TRow = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: TRow[]; rowCount: number | null }>;
}

/**
 * Run `fn` inside a transaction with `app.tenant_id` set to `tenantId`.
 * Every subsequent query made through the provided `client` is RLS-scoped.
 *
 * Throws:
 *   - `auth_tenant_mismatch` if `tenantId` is not a well-formed Brain tenant id
 *     (defence in depth; middleware already validated).
 *   - whatever `fn` throws, after rolling back.
 */
export async function withTenantScope<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: TenantScopedClient) => Promise<T>,
): Promise<T> {
  if (!isBrainId(tenantId, "tnt")) {
    throw brainError("auth_tenant_mismatch", "invalid tenant id shape", {
      details: { tenantId },
    });
  }

  const client: PoolClient = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    // `SET LOCAL` is TX-scoped. Safe against accidental inter-request leak.
    // Parameterized — pg will quote the ULID correctly. The cast isn't strictly
    // necessary (app.tenant_id is text) but keeps intent clear.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const scoped: TenantScopedClient = {
      query: (text, values) =>
        client.query(text, values as unknown as unknown[]) as Promise<{
          rows: never[];
          rowCount: number | null;
        }>,
    };
    const result = await fn(scoped);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (err) {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Swallow rollback errors — the original throw is what matters.
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read the current tenant scope from a live client. Primarily for testing
 * the helper itself, but occasionally useful for assertion inside a function
 * that wants to defensively confirm it is inside a `withTenantScope` block.
 */
export async function currentTenantScope(
  client: TenantScopedClient,
): Promise<string | null> {
  const { rows } = await client.query<{ tid: string | null }>(
    "SELECT current_setting('app.tenant_id', true) AS tid",
  );
  const tid = rows[0]?.tid ?? null;
  return tid === "" ? null : tid;
}
