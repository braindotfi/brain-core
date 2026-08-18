import {
  CANONICAL_TRANSACTION_CATEGORIES,
  newCategoryId,
  newTransactionCategoryAssignmentId,
  withTenantScope,
  type CanonicalTransactionCategoryCode,
  type AuditEmitter,
  type ServiceCallContext,
  type TenantScopedClient,
  type TransactionCategoryAssignmentMethod,
} from "@brain/shared";

export interface TransactionCategoryAssignmentInput {
  canonicalCode: CanonicalTransactionCategoryCode;
  method: TransactionCategoryAssignmentMethod;
  confidence: number;
  ruleVersion?: string;
  sourceCategory?: string;
}

export interface TransactionCategoryAssignmentResult {
  changed: boolean;
  assignmentId: string | null;
  categoryId: string;
  canonicalCode: CanonicalTransactionCategoryCode;
  replacedAssignmentId: string | null;
}

interface AssignmentRow {
  id: string;
  canonical_code: CanonicalTransactionCategoryCode;
  assignment_method: TransactionCategoryAssignmentMethod;
  category_id: string;
}

const METHOD_PRIORITY: Readonly<Record<TransactionCategoryAssignmentMethod, number>> = {
  deterministic_rule: 1,
  source_provided: 2,
  human_confirmed: 3,
};

function assertConfidence(confidence: number): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("transaction category assignment confidence must be in [0, 1]");
  }
}

/**
 * Applies one active canonical category to a transaction. The caller owns the
 * surrounding tenant transaction. Higher-priority human and source decisions
 * cannot be overwritten by a lower-priority deterministic rule.
 */
export async function assignTransactionCategory(
  c: TenantScopedClient,
  tenantId: string,
  transactionId: string,
  input: TransactionCategoryAssignmentInput,
): Promise<TransactionCategoryAssignmentResult> {
  assertConfidence(input.confidence);
  const definition = CANONICAL_TRANSACTION_CATEGORIES[input.canonicalCode];
  const { rows: existingCanonicalRows } = await c.query<{ id: string }>(
    `SELECT id FROM ledger_categories
      WHERE tenant_id = $1 AND canonical_code = $2
      LIMIT 1 FOR UPDATE`,
    [tenantId, input.canonicalCode],
  );
  let categoryId = existingCanonicalRows[0]?.id;
  if (categoryId === undefined) {
    const { rows: mappedNameRows } = await c.query<{ id: string }>(
      `UPDATE ledger_categories
          SET canonical_code = $1, updated_at = now()
        WHERE tenant_id = $2 AND name = $3 AND canonical_code IS NULL
      RETURNING id`,
      [input.canonicalCode, tenantId, definition.name],
    );
    categoryId = mappedNameRows[0]?.id;
  }
  if (categoryId === undefined) {
    const { rows: categoryRows } = await c.query<{ id: string }>(
      `INSERT INTO ledger_categories (id, tenant_id, name, kind, canonical_code)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, canonical_code) WHERE canonical_code IS NOT NULL
       DO UPDATE SET updated_at = now()
       RETURNING id`,
      [newCategoryId(), tenantId, definition.name, definition.kind, input.canonicalCode],
    );
    categoryId = categoryRows[0]?.id;
  }
  if (categoryId === undefined) throw new Error("canonical category upsert returned no row");

  const { rows: transactionRows } = await c.query<{ id: string }>(
    `SELECT id FROM ledger_transactions WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
    [transactionId, tenantId],
  );
  if (transactionRows[0] === undefined) {
    throw new Error("transaction category assignment requires a tenant transaction");
  }

  const { rows: activeRows } = await c.query<AssignmentRow>(
    `SELECT id, canonical_code, assignment_method, category_id
       FROM ledger_transaction_category_assignments
      WHERE tenant_id = $1 AND transaction_id = $2 AND superseded_at IS NULL
      FOR UPDATE`,
    [tenantId, transactionId],
  );
  const active = activeRows[0];
  if (active !== undefined) {
    if (active.canonical_code === input.canonicalCode && active.category_id === categoryId) {
      return {
        changed: false,
        assignmentId: active.id,
        categoryId,
        canonicalCode: input.canonicalCode,
        replacedAssignmentId: null,
      };
    }
    if (METHOD_PRIORITY[active.assignment_method] > METHOD_PRIORITY[input.method]) {
      return {
        changed: false,
        assignmentId: active.id,
        categoryId: active.category_id,
        canonicalCode: active.canonical_code,
        replacedAssignmentId: null,
      };
    }
  }

  const assignmentId = newTransactionCategoryAssignmentId();
  if (active !== undefined) {
    await c.query(
      `UPDATE ledger_transaction_category_assignments
          SET superseded_at = now(), superseded_by = $1
        WHERE id = $2 AND tenant_id = $3`,
      [assignmentId, active.id, tenantId],
    );
  }
  await c.query(
    `INSERT INTO ledger_transaction_category_assignments
       (id, tenant_id, transaction_id, category_id, canonical_code, assignment_method,
        confidence, rule_version, source_category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      assignmentId,
      tenantId,
      transactionId,
      categoryId,
      input.canonicalCode,
      input.method,
      input.confidence,
      input.ruleVersion ?? null,
      input.sourceCategory ?? null,
    ],
  );
  await c.query(`UPDATE ledger_transactions SET category_id = $1 WHERE id = $2 AND owner_id = $3`, [
    categoryId,
    transactionId,
    tenantId,
  ]);
  return {
    changed: true,
    assignmentId,
    categoryId,
    canonicalCode: input.canonicalCode,
    replacedAssignmentId: active?.id ?? null,
  };
}

/** Applies an explicit repair or human correction and records it in Audit. */
export async function assignTransactionCategoryForTenant(
  pool: Parameters<typeof withTenantScope>[0],
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  transactionId: string,
  input: TransactionCategoryAssignmentInput,
): Promise<TransactionCategoryAssignmentResult> {
  const result = await withTenantScope(pool, ctx.tenantId, (c) =>
    assignTransactionCategory(c, ctx.tenantId, transactionId, input),
  );
  if (result.changed) {
    await audit.emit({
      tenantId: ctx.tenantId,
      layer: "ledger",
      actor: ctx.actor,
      action: "ledger.transaction.category_assigned",
      inputs: {
        transaction_id: transactionId,
        canonical_code: result.canonicalCode,
        assignment_method: input.method,
      },
      outputs: {
        category_assignment_id: result.assignmentId,
        category_id: result.categoryId,
        superseded_assignment_id: result.replacedAssignmentId,
      },
    });
  }
  return result;
}
