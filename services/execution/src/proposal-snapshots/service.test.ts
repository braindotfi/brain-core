import { describe, expect, it } from "vitest";
import { newTenantId, newUserId, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { ProposalSnapshotService } from "./service.js";

const TENANT = newTenantId();
const USER = newUserId();

function ctx(): ServiceCallContext {
  return { tenantId: TENANT, actor: USER, scopes: ["execution:write"] };
}

describe("ProposalSnapshotService", () => {
  it("writes and reads immutable payload snapshots", async () => {
    const snapshots: Record<string, Record<string, unknown>> = {};
    const service = new ProposalSnapshotService(fakePool(snapshots));

    const created = await service.create(ctx(), { proposal_id: "prop_1", amount: "10.00" });
    snapshots[created.id] = { payload: { proposal_id: "prop_1", amount: "20.00" } };
    const fetched = await service.get(ctx(), created.id);

    expect(created.payload).toEqual({ proposal_id: "prop_1", amount: "10.00" });
    expect(fetched?.payload).toEqual({ proposal_id: "prop_1", amount: "10.00" });
    expect(created.payload_sha256).toBe(fetched?.payload_sha256);
  });
});

function fakePool(stored: Record<string, Record<string, unknown>>): Pool {
  let tenant: string | null = null;
  const rows: Array<{
    id: string;
    tenant_id: string;
    payload: Record<string, unknown>;
    payload_sha256: string;
    created_by: string;
    created_at: Date;
  }> = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
        return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT set_config")) {
        tenant = values[0] as string;
        return { rows: [], rowCount: 0 };
      }
      if (tenant !== TENANT) throw new Error("tenant scope missing");
      if (sql.includes("INSERT INTO proposal_payload_snapshots")) {
        const row = {
          id: values[0] as string,
          tenant_id: TENANT,
          payload: JSON.parse(values[1] as string) as Record<string, unknown>,
          payload_sha256: values[2] as string,
          created_by: values[3] as string,
          created_at: new Date("2026-01-01T00:00:00.000Z"),
        };
        rows.push(row);
        stored[row.id] = { payload: row.payload };
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("FROM proposal_payload_snapshots")) {
        const row = rows.find((candidate) => candidate.id === values[0]);
        return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}
