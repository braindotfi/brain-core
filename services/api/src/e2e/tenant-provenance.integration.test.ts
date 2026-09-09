import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Client, Pool } from "pg";
import { errorHandlerPlugin, newTenantId } from "@brain/shared";
import { applyAll, discoverMigrations } from "../../../../tools/migrate/src/index.js";
import { registerProductionTenancyRoutes } from "../production-tenancy/routes.js";

const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;
const PLATFORM_SECRET = "provenance-integration-platform-secret";

function repoRoot(): string {
  return new URL("../../../..", import.meta.url).pathname;
}

suite("tenant provenance route (requires DATABASE_URL)", () => {
  let pool: Pool;
  let schema: string;
  let app: FastifyInstance;
  const ordinaryTenantId = newTenantId();
  const syntheticTenantId = newTenantId();
  const legacyTenantId = newTenantId();

  beforeAll(async () => {
    schema = `tenant_provenance_${createHash("sha1")
      .update(String(process.pid) + String(Date.now()))
      .digest("hex")
      .slice(0, 12)}`;

    const bootstrap = new Client({ connectionString: DB_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end();

    pool = new Pool({ connectionString: DB_URL, max: 5, application_name: schema });
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${schema}, public`);
    });

    const migrator = await pool.connect();
    try {
      await migrator.query(`SET search_path TO ${schema}, public`);
      await applyAll(
        migrator as unknown as Parameters<typeof applyAll>[0],
        await discoverMigrations(repoRoot()),
        {
          appliedBy: "tenant-provenance-integration",
        },
      );
    } finally {
      migrator.release();
    }

    await pool.query(
      `INSERT INTO tenants
         (id, kind, sandbox, created_via, audit_anchor_mode,
          provisioning_state, data_profile, access_stage)
       VALUES
         ($1, 'production', FALSE, 'admin', 'onchain', NULL, 'customer', 'production'),
         ($2, 'production', FALSE, 'admin', 'db_only', 'ready_demo',
          'synthetic_brightline_v1', 'demo'),
         ($3, 'production', FALSE, 'admin', 'onchain', NULL, NULL, NULL)`,
      [ordinaryTenantId, syntheticTenantId, legacyTenantId],
    );

    app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    await registerProductionTenancyRoutes(app, {
      pool,
      resolverPool: pool,
      audit: { emit: async () => ({ id: "evt_unused" }) } as never,
      signer: { sign: async () => "unused" } as never,
      legacyAgentJwtNotAfter: undefined,
      platformSecret: PLATFORM_SECRET,
    });
  }, 60_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (pool !== undefined) await pool.end();
    if (schema !== undefined && DB_URL !== undefined) {
      const teardown = new Client({ connectionString: DB_URL });
      await teardown.connect();
      await teardown.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await teardown.end();
    }
  }, 60_000);

  it("returns ordinary production provenance", async () => {
    await expectProvenance(ordinaryTenantId, {
      tenant_id: ordinaryTenantId,
      kind: "production",
      provisioning_state: null,
      data_profile: "customer",
      access_stage: "production",
    });
  });

  it("returns synthetic demo provenance", async () => {
    await expectProvenance(syntheticTenantId, {
      tenant_id: syntheticTenantId,
      kind: "production",
      provisioning_state: "ready_demo",
      data_profile: "synthetic_brightline_v1",
      access_stage: "demo",
    });
  });

  it("returns explicit nulls for unclassified legacy provenance", async () => {
    await expectProvenance(legacyTenantId, {
      tenant_id: legacyTenantId,
      kind: "production",
      provisioning_state: null,
      data_profile: null,
      access_stage: null,
    });
  });

  it("returns 404 for an unknown tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/tenants/${newTenantId()}/provenance`,
      headers: { "x-platform-service-auth": PLATFORM_SECRET },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("tenant_not_found");
  });

  async function expectProvenance(tenantId: string, expected: Record<string, unknown>) {
    const response = await app.inject({
      method: "GET",
      url: `/tenants/${tenantId}/provenance`,
      headers: { "x-platform-service-auth": PLATFORM_SECRET },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
  }
});
