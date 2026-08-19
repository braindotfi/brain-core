/**
 * Canonical transaction categories are stable cross-tenant codes. Tenant-local
 * ledger_categories remain the user-visible category records and map to these
 * codes rather than being replaced by them.
 */
export const CANONICAL_TRANSACTION_CATEGORY_CODES = [
  "income.subscription_revenue",
  "expense.payroll_and_benefits",
  "expense.cloud_infrastructure",
  "expense.general_and_administrative",
] as const;

export type CanonicalTransactionCategoryCode =
  (typeof CANONICAL_TRANSACTION_CATEGORY_CODES)[number];

export type TransactionCategoryAssignmentMethod =
  | "source_provided"
  | "deterministic_rule"
  | "human_confirmed";

export interface CanonicalTransactionCategoryDefinition {
  name: string;
  kind: "income" | "expense";
}

export const CANONICAL_TRANSACTION_CATEGORIES: Readonly<
  Record<CanonicalTransactionCategoryCode, CanonicalTransactionCategoryDefinition>
> = {
  "income.subscription_revenue": {
    name: "Subscription revenue",
    kind: "income",
  },
  "expense.payroll_and_benefits": {
    name: "Payroll and benefits",
    kind: "expense",
  },
  "expense.cloud_infrastructure": {
    name: "Cloud infrastructure",
    kind: "expense",
  },
  "expense.general_and_administrative": {
    name: "General and administrative",
    kind: "expense",
  },
};

export function isCanonicalTransactionCategoryCode(
  value: string,
): value is CanonicalTransactionCategoryCode {
  return (CANONICAL_TRANSACTION_CATEGORY_CODES as readonly string[]).includes(value);
}
