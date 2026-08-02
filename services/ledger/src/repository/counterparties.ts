import type { KeysetCursor, TenantScopedClient } from "@brain/shared";
import type { LedgerRowCommon } from "./types.js";
import { normalizeName } from "../service/writes.js";

export interface CounterpartyRow extends LedgerRowCommon {
  name: string;
  normalized_name: string | null;
  type: string;
  risk_level: string | null;
  verified_status: string | null;
  trust_status: string;
  trust_reviewed_at: Date | string | null;
  trust_reviewed_by: string | null;
  aliases: string[];
  linked_accounts: string[];
  /** For type="agent": the execution-layer agent id (RFC 0001); null otherwise. */
  agent_id: string | null;
  /** Payee on-chain (EVM) address for x402/on-chain settlement; null off-chain (RFC 0001 §6.1). */
  onchain_address: string | null;
  /** Tenant-scoped, off-chain structured context with no dedicated column
   *  (e.g. demo vendor ceiling / customer enrichment). Defaults to {}. */
  metadata: Record<string, unknown>;
  payment_count?: number | string | null;
  payment_total?: string | null;
}

export interface CounterpartyListFilters {
  q?: string;
  type?: string;
  verified_status?: string;
  trust_status?: string;
  limit: number;
  cursor?: KeysetCursor;
}

export interface CounterpartyIdentityPatch {
  name?: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  provenance?: "human_confirmed";
}

export async function findCounterpartyById(
  client: TenantScopedClient,
  id: string,
): Promise<CounterpartyRow | null> {
  const { rows } = await client.query<CounterpartyRow>(
    `SELECT cp.*,
            COALESCE(payment_rollup.payment_count, 0)::int AS payment_count,
            COALESCE(payment_rollup.payment_total, '0') AS payment_total
       FROM ledger_counterparties cp
       LEFT JOIN (
         SELECT counterparty_id,
                count(*)::int AS payment_count,
                COALESCE(sum(amount), 0)::text AS payment_total
           FROM ledger_transactions
          WHERE owner_id = current_setting('app.tenant_id', true)
            AND counterparty_id IS NOT NULL
            AND direction = 'outflow'
            AND status IN ('posted', 'cleared')
          GROUP BY counterparty_id
       ) payment_rollup ON payment_rollup.counterparty_id = cp.id
      WHERE cp.id = $1 AND cp.owner_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listCounterparties(
  client: TenantScopedClient,
  filters: CounterpartyListFilters,
): Promise<CounterpartyRow[]> {
  const where: string[] = [`cp.owner_id = current_setting('app.tenant_id', true)`];
  const values: unknown[] = [];
  if (filters.type !== undefined) {
    values.push(filters.type);
    where.push(`cp.type = $${values.length}`);
  }
  if (filters.verified_status !== undefined) {
    values.push(filters.verified_status);
    where.push(`cp.verified_status = $${values.length}`);
  }
  if (filters.trust_status !== undefined) {
    values.push(filters.trust_status);
    where.push(`cp.trust_status = $${values.length}`);
  }
  if (filters.q !== undefined && filters.q !== "") {
    const normalized = normalizeName(filters.q);
    values.push(`%${normalized}%`);
    where.push(
      `(LOWER(COALESCE(cp.normalized_name, '')) LIKE $${values.length}
        OR EXISTS (
          SELECT 1
            FROM unnest(cp.aliases) AS alias
           WHERE LOWER(alias) = LOWER($${values.length + 1})
        ))`,
    );
    values.push(filters.q.trim());
  }
  if (filters.cursor !== undefined) {
    values.push(filters.cursor.sort, filters.cursor.id);
    const sortIdx = values.length - 1;
    const idIdx = values.length;
    where.push(`(cp.name > $${sortIdx} OR (cp.name = $${sortIdx} AND cp.id > $${idIdx}))`);
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<CounterpartyRow>(
    `SELECT cp.*,
            COALESCE(payment_rollup.payment_count, 0)::int AS payment_count,
            COALESCE(payment_rollup.payment_total, '0') AS payment_total
       FROM ledger_counterparties cp
       LEFT JOIN (
         SELECT counterparty_id,
                count(*)::int AS payment_count,
                COALESCE(sum(amount), 0)::text AS payment_total
           FROM ledger_transactions
          WHERE owner_id = current_setting('app.tenant_id', true)
            AND counterparty_id IS NOT NULL
            AND direction = 'outflow'
            AND status IN ('posted', 'cleared')
          GROUP BY counterparty_id
       ) payment_rollup ON payment_rollup.counterparty_id = cp.id
     ${whereSql}
     ORDER BY cp.name ASC, cp.id ASC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}

export async function findCounterpartyByNormalizedName(
  client: TenantScopedClient,
  normalizedName: string,
  type: string,
): Promise<CounterpartyRow | null> {
  const { rows } = await client.query<CounterpartyRow>(
    `SELECT * FROM ledger_counterparties
      WHERE normalized_name = $1
        AND type = $2
        AND owner_id = current_setting('app.tenant_id', true)
      LIMIT 1`,
    [normalizedName, type],
  );
  return rows[0] ?? null;
}

export async function updateCounterpartyIdentity(
  client: TenantScopedClient,
  id: string,
  patch: CounterpartyIdentityPatch,
): Promise<CounterpartyRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    values.push(patch.name);
    sets.push(`name = $${values.length}`);
    values.push(normalizeName(patch.name).slice(0, 200));
    sets.push(`normalized_name = $${values.length}`);
  }
  if (patch.aliases !== undefined) {
    values.push(patch.aliases);
    sets.push(`aliases = $${values.length}`);
  }
  if (patch.metadata !== undefined) {
    values.push(JSON.stringify(patch.metadata));
    sets.push(`metadata = metadata || $${values.length}::jsonb`);
  }
  if (patch.provenance !== undefined) {
    values.push(patch.provenance);
    sets.push(`provenance = $${values.length}`);
  }
  if (sets.length === 0) {
    return findCounterpartyById(client, id);
  }
  sets.push("updated_at = now()");
  values.push(id);
  const idIndex = values.length;
  const { rows } = await client.query<CounterpartyRow>(
    `UPDATE ledger_counterparties
        SET ${sets.join(", ")}
      WHERE id = $${idIndex}
        AND owner_id = current_setting('app.tenant_id', true)
      RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}
