import type { QueryResult } from "pg";

export const TENANT_DELETION_ROLE = "brain_tenant_deletion";

type TablePrivilege =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE"
  | "REFERENCES"
  | "TRIGGER";

export interface TenantDeletionPrivilegeClient {
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ) => Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
}

interface PrivilegeExpectation {
  table: string;
  privilege: TablePrivilege;
  expected: boolean;
}

export interface TenantDeletionPrivilegeReport {
  role: string;
  superuser: boolean;
  tableOwnerMatches: string[];
  checkedPrivileges: number;
}

const MUTATION_AND_DDL_PRIVILEGES: readonly TablePrivilege[] = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];

function addExpected(
  expectations: Map<string, PrivilegeExpectation>,
  table: string,
  privileges: readonly TablePrivilege[],
  expected: boolean,
): void {
  for (const privilege of privileges) {
    expectations.set(`${table}:${privilege}`, { table, privilege, expected });
  }
}

export function tenantDeletionPrivilegeExpectations(
  deletionTables: readonly string[],
): PrivilegeExpectation[] {
  const expectations = new Map<string, PrivilegeExpectation>();
  for (const table of deletionTables) {
    addExpected(expectations, table, ["SELECT", "DELETE"], true);
  }
  addExpected(expectations, "agents", ["UPDATE"], false);
  addExpected(expectations, "tenants", ["SELECT", "UPDATE", "DELETE"], true);
  addExpected(expectations, "audit_events", ["SELECT"], true);
  addExpected(expectations, "audit_anchors", ["SELECT"], true);
  addExpected(expectations, "audit_integrity_findings", ["SELECT"], true);
  addExpected(expectations, "audit_integrity_findings", MUTATION_AND_DDL_PRIVILEGES, false);
  addExpected(
    expectations,
    "audit_verifier_checkpoint",
    ["SELECT", ...MUTATION_AND_DDL_PRIVILEGES],
    false,
  );
  addExpected(expectations, "tenant_blob_purge_jobs", ["SELECT", "INSERT", "UPDATE"], true);
  addExpected(expectations, "tenant_blob_purge_audit_outbox", ["SELECT", "INSERT", "UPDATE"], true);
  addExpected(expectations, "tenant_deletion_jobs", ["SELECT", "INSERT", "UPDATE"], true);
  addExpected(
    expectations,
    "tenant_deletion_jobs",
    ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
    false,
  );
  addExpected(
    expectations,
    "commercial_demo_retirement_progress",
    ["SELECT", "INSERT", "UPDATE"],
    true,
  );
  addExpected(
    expectations,
    "commercial_demo_retirement_progress",
    ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
    false,
  );
  return [...expectations.values()].sort(
    (left, right) =>
      left.table.localeCompare(right.table) || left.privilege.localeCompare(right.privilege),
  );
}

export async function assertTenantDeletionPrivilegeContract(
  client: TenantDeletionPrivilegeClient,
  deletionTables: readonly string[],
): Promise<TenantDeletionPrivilegeReport> {
  const identity = await client.query<{ role: string; superuser: boolean }>(
    `SELECT current_user AS role,
            COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS superuser`,
  );
  const role = identity.rows[0];
  if (role?.role !== TENANT_DELETION_ROLE || role.superuser) {
    throw new Error(`unexpected tenant-deletion role identity: ${JSON.stringify(role)}`);
  }

  const expectations = tenantDeletionPrivilegeExpectations(deletionTables);
  const tables = [...new Set(expectations.map(({ table }) => table))];
  const owners = await client.query<{ table_name: string; owner_name: string }>(
    `SELECT relation.relname AS table_name,
            pg_get_userbyid(relation.relowner) AS owner_name
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY($1::text[])
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname`,
    [tables],
  );
  const foundTables = new Set(owners.rows.map(({ table_name }) => table_name));
  const missingTables = tables.filter((table) => !foundTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`tenant-deletion privilege tables are absent: ${missingTables.join(",")}`);
  }
  const tableOwnerMatches = owners.rows
    .filter(({ owner_name }) => owner_name === TENANT_DELETION_ROLE)
    .map(({ table_name }) => table_name);
  if (tableOwnerMatches.length > 0) {
    throw new Error(
      `tenant-deletion role unexpectedly owns tables: ${tableOwnerMatches.join(",")}`,
    );
  }

  const results = await client.query<{
    table_name: string;
    privilege_name: TablePrivilege;
    expected: boolean;
    actual: boolean;
  }>(
    `SELECT expectation.table_name,
            expectation.privilege_name,
            expectation.expected,
            has_table_privilege(
              current_user,
              format('public.%I', expectation.table_name),
              expectation.privilege_name
            ) AS actual
       FROM jsonb_to_recordset($1::jsonb)
         AS expectation(table_name text, privilege_name text, expected boolean)
      ORDER BY expectation.table_name, expectation.privilege_name`,
    [
      JSON.stringify(
        expectations.map(({ table, privilege, expected }) => ({
          table_name: table,
          privilege_name: privilege,
          expected,
        })),
      ),
    ],
  );
  const mismatches = results.rows.filter(({ actual, expected }) => actual !== expected);
  if (mismatches.length > 0) {
    throw new Error(`tenant-deletion privilege contract failed: ${JSON.stringify(mismatches)}`);
  }

  const agentUpdateColumns = await client.query<{
    column_name: string;
    actual: boolean;
    expected: boolean;
  }>(
    `SELECT column_name,
            has_column_privilege(current_user, 'public.agents', column_name, 'UPDATE') AS actual,
            (column_name = 'state') AS expected
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agents'
      ORDER BY ordinal_position`,
  );
  const columnMismatches = agentUpdateColumns.rows.filter(
    ({ actual, expected }) => actual !== expected,
  );
  if (columnMismatches.length > 0) {
    throw new Error(
      `tenant-deletion agent UPDATE contract failed: ${JSON.stringify(columnMismatches)}`,
    );
  }

  return {
    role: role.role,
    superuser: role.superuser,
    tableOwnerMatches,
    checkedPrivileges: results.rows.length + agentUpdateColumns.rows.length,
  };
}
