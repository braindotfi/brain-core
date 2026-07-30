import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTenantId } from "@brain/shared";
import { buildAuthHarness, type AuthHarness } from "./harness.js";

const DB_URL = process.env.DATABASE_URL;
const DESCRIBE = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;

let h: AuthHarness | null = null;

DESCRIBE("oauth migration 0001 (requires DATABASE_URL)", () => {
  beforeAll(async () => {
    h = await buildAuthHarness();
  }, 60_000);

  afterAll(async () => {
    if (h !== null) await h.cleanup();
  });

  it("applies cleanly and creates all four tables", async () => {
    if (h === null) return;
    const { rows } = await h.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name IN ('oauth_clients', 'oauth_authorization_codes',
                             'oauth_consent_grants', 'oauth_refresh_tokens')
       ORDER BY table_name`,
      [h.schema],
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "oauth_authorization_codes",
      "oauth_clients",
      "oauth_consent_grants",
      "oauth_refresh_tokens",
    ]);
  });

  it("accepts code_challenge_method = 'S256'", async () => {
    if (h === null) return;
    const tenantId = newTenantId();
    await h.pool.query("INSERT INTO tenants (id) VALUES ($1)", [tenantId]);
    await expect(
      h.pool.query(
        `INSERT INTO oauth_authorization_codes (
           code_hash, client_id, tenant_id, agent_id, member_id, grant_id,
           scopes, redirect_uri, code_challenge, code_challenge_method, expires_at
         ) VALUES ($1, 'oacl_test', $2, 'agent_test', 'mem_test', 'ogr_test',
           ARRAY['ledger:read'], 'https://example.test/cb', 'challenge-value',
           'S256', now() + interval '60 seconds')`,
        [`s256-code-hash-${tenantId}`, tenantId],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects code_challenge_method = 'plain' via the CHECK constraint", async () => {
    if (h === null) return;
    const tenantId = newTenantId();
    await h.pool.query("INSERT INTO tenants (id) VALUES ($1)", [tenantId]);
    await expect(
      h.pool.query(
        `INSERT INTO oauth_authorization_codes (
           code_hash, client_id, tenant_id, agent_id, member_id, grant_id,
           scopes, redirect_uri, code_challenge, code_challenge_method, expires_at
         ) VALUES ($1, 'oacl_test', $2, 'agent_test', 'mem_test', 'ogr_test',
           ARRAY['ledger:read'], 'https://example.test/cb', 'challenge-value',
           'plain', now() + interval '60 seconds')`,
        [`plain-code-hash-${tenantId}`, tenantId],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });
});
