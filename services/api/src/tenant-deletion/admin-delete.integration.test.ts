import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { newAgentId, newApiPartnerId, newTenantDeletionJobId, newTenantId } from "@brain/shared";
import { runTenantDeletionCycle } from "./admin-delete-worker.js";
import { AdminTenantDeletionService } from "./admin-delete.js";

const OWNER_URL = process.env.DATABASE_URL;
const DELETION_URL = process.env.DATABASE_URL_TENANT_DELETION;
const suite = OWNER_URL && DELETION_URL ? describe.sequential : describe.skip;

suite("admin tenant deletion as brain_tenant_deletion", () => {
  let owner: Pool;
  let deletion: Pool;
  const cleanupIds = new Set<string>();

  beforeAll(() => {
    owner = new Pool({ connectionString: OWNER_URL });
    deletion = new Pool({ connectionString: DELETION_URL });
  });

  afterAll(async () => {
    if (owner !== undefined) {
      const ids = [...cleanupIds];
      await owner.query(`DELETE FROM tenant_blob_purge_audit_outbox WHERE tenant_id = ANY($1)`, [
        ids,
      ]);
      await owner.query(`DELETE FROM tenant_blob_purge_jobs WHERE tenant_id = ANY($1)`, [ids]);
      await owner.query(`DELETE FROM tenant_deletion_jobs WHERE tenant_id = ANY($1)`, [ids]);
      await owner.query(`DELETE FROM agents WHERE tenant_id = ANY($1)`, [ids]);
      await owner.query(`DELETE FROM tenants WHERE id = ANY($1)`, [ids]);
      await owner.end();
    }
    if (deletion !== undefined) await deletion.end();
  });

  async function seedTenant() {
    const tenantId = newTenantId();
    const agentId = newAgentId();
    const jobId = newTenantDeletionJobId();
    cleanupIds.add(tenantId);
    await owner.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
    await owner.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state)
       VALUES ($1, $2, 'internal', 'payment', 'Deletion test', 'active')`,
      [agentId, tenantId],
    );
    await owner.query(
      `INSERT INTO tenant_deletion_jobs (id, tenant_id, requested_by)
       VALUES ($1, $2, $3)`,
      [jobId, tenantId, newApiPartnerId()],
    );
    return { tenantId, agentId, jobId };
  }

  it("rejects a protected tenant without changing tenant or agent data", async () => {
    const tenantId = newTenantId();
    const agentId = newAgentId();
    cleanupIds.add(tenantId);
    await owner.query(`INSERT INTO tenants (id, do_not_delete) VALUES ($1, true)`, [tenantId]);
    await owner.query(
      `INSERT INTO agents (id, tenant_id, kind, role, display_name, state)
       VALUES ($1, $2, 'internal', 'payment', 'Protected test', 'active')`,
      [agentId, tenantId],
    );
    const service = new AdminTenantDeletionService(deletion);

    await expect(
      service.request(tenantId, newApiPartnerId(), "protected-integration-attempt"),
    ).rejects.toMatchObject({ code: "tenant_access_denied" });

    expect((await owner.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId])).rowCount).toBe(1);
    expect(
      (await owner.query(`SELECT state FROM agents WHERE id = $1`, [agentId])).rows[0],
    ).toEqual({ state: "active" });
    expect(
      (await owner.query(`SELECT 1 FROM tenant_deletion_jobs WHERE tenant_id = $1`, [tenantId]))
        .rowCount,
    ).toBe(0);
  });

  it("returns one durable job id for repeated requests", async () => {
    const tenantId = newTenantId();
    cleanupIds.add(tenantId);
    await owner.query(`INSERT INTO tenants (id) VALUES ($1)`, [tenantId]);
    const caller = newApiPartnerId();
    const service = new AdminTenantDeletionService(deletion);

    const first = await service.request(tenantId, caller, "idempotency-one");
    const second = await service.request(tenantId, caller, "idempotency-two");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    await owner.query(`UPDATE tenant_deletion_jobs SET status = 'failed' WHERE id = $1`, [
      first.row.id,
    ]);
  });

  it("deletes one tenant transactionally as the narrow role", async () => {
    const target = await seedTenant();
    const bystander = await seedTenant();
    await owner.query(`UPDATE tenant_deletion_jobs SET status = 'failed' WHERE id = $1`, [
      bystander.jobId,
    ]);

    await expect(
      runTenantDeletionCycle({ pool: deletion, workerId: "integration-delete" }),
    ).resolves.toBe(true);

    expect(
      (await owner.query(`SELECT 1 FROM tenants WHERE id = $1`, [target.tenantId])).rowCount,
    ).toBe(0);
    expect(
      (await owner.query(`SELECT state FROM agents WHERE id = $1`, [bystander.agentId])).rows[0],
    ).toEqual({ state: "active" });
    expect(
      (await owner.query(`SELECT status FROM tenant_deletion_jobs WHERE id = $1`, [target.jobId]))
        .rows[0],
    ).toEqual({ status: "completed" });
  }, 60_000);

  it("rolls back a lock-conflicted tenant, restores its agent, and leaves other tenants untouched", async () => {
    const target = await seedTenant();
    const bystander = await seedTenant();
    await owner.query(`UPDATE tenant_deletion_jobs SET status = 'failed' WHERE id = $1`, [
      bystander.jobId,
    ]);
    const locker = await owner.connect();
    await locker.query("BEGIN");
    await locker.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [target.tenantId]);
    try {
      await expect(
        runTenantDeletionCycle({ pool: deletion, workerId: "integration-failure" }),
      ).resolves.toBe(true);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }

    expect(
      (await owner.query(`SELECT 1 FROM tenants WHERE id = $1`, [target.tenantId])).rowCount,
    ).toBe(1);
    expect(
      (await owner.query(`SELECT state FROM agents WHERE id = $1`, [target.agentId])).rows[0],
    ).toEqual({ state: "active" });
    expect(
      (await owner.query(`SELECT 1 FROM tenants WHERE id = $1`, [bystander.tenantId])).rowCount,
    ).toBe(1);
    expect(
      (await owner.query(`SELECT status FROM tenant_deletion_jobs WHERE id = $1`, [target.jobId]))
        .rows[0],
    ).toEqual({ status: "failed" });
  }, 60_000);

  it("rolls back a failure late in the delete order and leaves other tenants untouched", async () => {
    const target = await seedTenant();
    const bystander = await seedTenant();
    await owner.query(`UPDATE tenant_deletion_jobs SET status = 'failed' WHERE id = $1`, [
      bystander.jobId,
    ]);
    await owner.query(`DROP TRIGGER IF EXISTS test_admin_tenant_delete_failure ON agents`);
    await owner.query(`
      CREATE OR REPLACE FUNCTION test_admin_tenant_delete_failure()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'injected late deletion failure';
      END
      $$
    `);
    await owner.query(`
      CREATE TRIGGER test_admin_tenant_delete_failure
      BEFORE DELETE ON agents
      FOR EACH ROW
      EXECUTE FUNCTION test_admin_tenant_delete_failure()
    `);
    try {
      await expect(
        runTenantDeletionCycle({ pool: deletion, workerId: "integration-mid-delete-failure" }),
      ).resolves.toBe(true);
    } finally {
      await owner.query(`DROP TRIGGER test_admin_tenant_delete_failure ON agents`);
      await owner.query(`DROP FUNCTION test_admin_tenant_delete_failure()`);
    }

    expect(
      (await owner.query(`SELECT 1 FROM tenants WHERE id = $1`, [target.tenantId])).rowCount,
    ).toBe(1);
    expect(
      (await owner.query(`SELECT state FROM agents WHERE id = $1`, [target.agentId])).rows[0],
    ).toEqual({ state: "active" });
    expect(
      (await owner.query(`SELECT 1 FROM tenants WHERE id = $1`, [bystander.tenantId])).rowCount,
    ).toBe(1);
    expect(
      (await owner.query(`SELECT state FROM agents WHERE id = $1`, [bystander.agentId])).rows[0],
    ).toEqual({ state: "active" });
    expect(
      (await owner.query(`SELECT status FROM tenant_deletion_jobs WHERE id = $1`, [target.jobId]))
        .rows[0],
    ).toEqual({ status: "failed" });
  }, 60_000);
});
