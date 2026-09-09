import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe;
const schema = `commercial_backfill_${process.pid}_${Date.now()}`;

suite("commercial entity legacy backfill", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        business_name TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE tenant_graduation_evidence (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        evidence_version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        action TEXT NOT NULL,
        inputs JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE robotmoney_entities (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        legal_name TEXT,
        state TEXT NOT NULL,
        commercial_cap_revision_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO tenants (id) VALUES ('tnt_named'), ('tnt_unclassified');
      INSERT INTO audit_events (id, tenant_id, action, inputs)
      VALUES ('evt_named', 'tnt_named', 'tenant.created', '{"company_name":"Acme"}');
    `);

    for (const migration of [
      "0022_unclassified_robotmoney_backfill_preflight.sql",
      "0023_robotmoney_default_entity_backfill.sql",
      "0024_unclassified_robotmoney_backfill_cleanup.sql",
    ]) {
      const sql = await readFile(
        resolve(process.cwd(), `../audit/migrations/${migration}`),
        "utf8",
      );
      await client.query(sql);
    }
  });

  afterAll(async () => {
    if (client === undefined) return;
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  it("creates the active entity from the recovered canonical name", async () => {
    const { rows } = await client.query(
      `SELECT tenant.business_name, entity.display_name, entity.legal_name,
              entity.state, entity.created_by
         FROM tenants AS tenant
         JOIN robotmoney_entities AS entity ON entity.tenant_id = tenant.id
        WHERE tenant.id = 'tnt_named'`,
    );

    expect(rows).toEqual([
      {
        business_name: "Acme",
        display_name: "Acme",
        legal_name: "Acme",
        state: "active",
        created_by: "commercial_entity_backfill_v1",
      },
    ]);
  });

  it("leaves an unnamed legacy tenant explicitly unclassified and inactive", async () => {
    const { rows } = await client.query(
      `SELECT tenant.business_name, entity.display_name, entity.legal_name,
              entity.state, entity.created_by
         FROM tenants AS tenant
         JOIN robotmoney_entities AS entity ON entity.tenant_id = tenant.id
        WHERE tenant.id = 'tnt_unclassified'`,
    );

    expect(rows).toEqual([
      {
        business_name: null,
        display_name: "tnt_unclassified",
        legal_name: null,
        state: "draft",
        created_by: "commercial_unclassified_legacy_v1",
      },
    ]);
  });

  it("removes the compatibility tracking table", async () => {
    const { rows } = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('robotmoney_entity_backfill_deferred_tenants')::text AS relation",
    );
    expect(rows[0]?.relation).toBeNull();
  });
});
