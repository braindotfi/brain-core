import type { TenantScopedClient } from "@brain/api/shared";
import type { LedgerRowCommon } from "./types.js";

export interface DocumentRow extends LedgerRowCommon {
  document_type: string;
  source_uri: string | null;
  extracted_fields: Record<string, unknown>;
  linked_account_ids: string[];
  linked_transaction_ids: string[];
  linked_obligation_ids: string[];
  confidence_score: number | null;
}

export async function findDocumentById(
  client: TenantScopedClient,
  id: string,
): Promise<DocumentRow | null> {
  const { rows } = await client.query<DocumentRow>(
    `SELECT * FROM ledger_documents WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listDocuments(
  client: TenantScopedClient,
  filters: { document_type?: string; limit: number },
): Promise<DocumentRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.document_type !== undefined) {
    values.push(filters.document_type);
    where.push(`document_type = $${values.length}`);
  }
  values.push(filters.limit);
  const limitIdx = values.length;
  const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
  const { rows } = await client.query<DocumentRow>(
    `SELECT * FROM ledger_documents ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${limitIdx}`,
    values,
  );
  return rows;
}
