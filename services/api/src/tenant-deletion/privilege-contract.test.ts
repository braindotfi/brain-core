import { describe, expect, it, vi } from "vitest";
import {
  assertTenantDeletionPrivilegeContract,
  tenantDeletionPrivilegeExpectations,
  type TenantDeletionPrivilegeClient,
} from "./privilege-contract.js";

function privilegeClient(
  options: {
    missingTenantUpdate?: boolean;
    missingAgentStateUpdate?: boolean;
    superuser?: boolean;
  } = {},
) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [{ role: "brain_tenant_deletion", superuser: options.superuser ?? false }],
      rowCount: 1,
    })
    .mockImplementationOnce((_sql: string, values?: unknown[]) => ({
      rows: ((values?.[0] as string[]) ?? []).map((table_name) => ({
        table_name,
        owner_name: "brain",
      })),
      rowCount: ((values?.[0] as string[]) ?? []).length,
    }))
    .mockImplementationOnce((_sql: string, values?: unknown[]) => {
      const expectations = JSON.parse(String(values?.[0])) as Array<{
        table_name: string;
        privilege_name: string;
        expected: boolean;
      }>;
      return {
        rows: expectations.map((expectation) => ({
          ...expectation,
          actual:
            options.missingTenantUpdate === true &&
            expectation.table_name === "tenants" &&
            expectation.privilege_name === "UPDATE"
              ? false
              : expectation.expected,
        })),
        rowCount: expectations.length,
      };
    })
    .mockImplementationOnce(() => ({
      rows: [
        {
          column_name: "id",
          expected: false,
          actual: false,
        },
        {
          column_name: "state",
          expected: true,
          actual: options.missingAgentStateUpdate !== true,
        },
      ],
      rowCount: 2,
    }));
  return { query, client: { query: query as TenantDeletionPrivilegeClient["query"] } };
}

describe("tenant-deletion privilege contract", () => {
  it("requires the exact tenant lock and batch deletion privileges", () => {
    const expectations = tenantDeletionPrivilegeExpectations(["agent_runs"]);
    expect(expectations).toEqual(
      expect.arrayContaining([
        { table: "agent_runs", privilege: "SELECT", expected: true },
        { table: "agent_runs", privilege: "DELETE", expected: true },
        { table: "agents", privilege: "UPDATE", expected: false },
        { table: "tenants", privilege: "SELECT", expected: true },
        { table: "tenants", privilege: "UPDATE", expected: true },
        { table: "tenants", privilege: "DELETE", expected: true },
        { table: "audit_integrity_findings", privilege: "SELECT", expected: true },
        { table: "audit_integrity_findings", privilege: "UPDATE", expected: false },
        { table: "audit_verifier_checkpoint", privilege: "SELECT", expected: false },
        {
          table: "commercial_demo_retirement_progress",
          privilege: "INSERT",
          expected: true,
        },
        {
          table: "commercial_demo_retirement_progress",
          privilege: "DELETE",
          expected: false,
        },
      ]),
    );
  });

  it("passes only for the non-superuser deletion role with matching grants", async () => {
    const { client } = privilegeClient();
    await expect(
      assertTenantDeletionPrivilegeContract(client, ["agent_runs"]),
    ).resolves.toMatchObject({
      role: "brain_tenant_deletion",
      superuser: false,
      tableOwnerMatches: [],
    });
  });

  it("fails closed when tenants UPDATE is missing", async () => {
    const { client } = privilegeClient({ missingTenantUpdate: true });
    await expect(assertTenantDeletionPrivilegeContract(client, ["agent_runs"])).rejects.toThrow(
      '"table_name":"tenants","privilege_name":"UPDATE","expected":true,"actual":false',
    );
  });

  it("fails closed when agents.state UPDATE is missing", async () => {
    const { client } = privilegeClient({ missingAgentStateUpdate: true });
    await expect(assertTenantDeletionPrivilegeContract(client, ["agent_runs"])).rejects.toThrow(
      "tenant-deletion agent UPDATE contract failed",
    );
  });

  it("rejects a superuser connection", async () => {
    const { client } = privilegeClient({ superuser: true });
    await expect(assertTenantDeletionPrivilegeContract(client, ["agent_runs"])).rejects.toThrow(
      "unexpected tenant-deletion role identity",
    );
  });
});
