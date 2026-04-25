import type { TenantScopedClient } from "@brain/api/shared";

export interface CategoryRow {
  id: string;
  tenant_id: string;
  name: string;
  parent_id: string | null;
  kind: string;
  created_at: Date;
  updated_at: Date;
}

export async function findCategoryById(
  client: TenantScopedClient,
  id: string,
): Promise<CategoryRow | null> {
  const { rows } = await client.query<CategoryRow>(
    `SELECT * FROM ledger_categories WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listCategories(
  client: TenantScopedClient,
  filters: { kind?: string; limit: number },
): Promise<CategoryRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.kind !== undefined) {
    values.push(filters.kind);
    where.push(`kind = $${values.length}`);
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<CategoryRow>(
    `SELECT * FROM ledger_categories ${whereSql}
     ORDER BY name ASC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
