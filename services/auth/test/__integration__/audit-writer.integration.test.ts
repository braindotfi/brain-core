/**
 * Runtime-as-role proof that brain_auth_audit_writer (infra/db-roles.sql)
 * can actually complete PostgresAuditEmitter.emit end to end (finding 1).
 *
 * human-auth.integration.test.ts injects InMemoryAuditEmitter and grants
 * brain_auth a blanket ALL TABLES privilege in its private schema, so it
 * never exercises this role's REAL, narrow audit_events grant. This suite
 * connects as brain_auth_audit_writer with exactly the SELECT, INSERT grant
 * infra/db-roles.sql ships (no blanket schema grant), so a future edit that
 * drops the SELECT half of that grant (the hash-chain predecessor read
 * PostgresAuditEmitter.emit runs before every insert) 42501s here and fails
 * CI, instead of surfacing only as a live /forgot-password 500.
 *
 * Requires DATABASE_URL (owner, for the harness) and DATABASE_URL_AUTH_AUDIT
 * (brain_auth_audit_writer). Skips cleanly when either is absent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresAuditEmitter, newTenantId } from "@brain/shared";
import { buildAuthHarness, type AuthHarness } from "./harness.js";

const DB_URL = process.env.DATABASE_URL;
const AUDIT_URL = process.env.DATABASE_URL_AUTH_AUDIT;
const DESCRIBE = DB_URL !== undefined && AUDIT_URL !== undefined ? describe : describe.skip;

let h: AuthHarness | null = null;
let auditPool: Pool | null = null;

DESCRIBE("brain_auth_audit_writer (requires DATABASE_URL, DATABASE_URL_AUTH_AUDIT)", () => {
  beforeAll(async () => {
    h = await buildAuthHarness();
    if (h === null) return;
    // Mirrors infra/db-roles.sql's real footprint for this role EXACTLY --
    // SELECT, INSERT only, no blanket ALL TABLES grant. If a future SQL edit
    // narrows this back to INSERT-only, this GRANT stays the same but the
    // emit below starts 42501ing.
    await h.pool.query(`GRANT USAGE ON SCHEMA ${h.schema} TO brain_auth_audit_writer`);
    await h.pool.query(`GRANT SELECT, INSERT ON audit_events TO brain_auth_audit_writer`);

    const schema = h.schema;
    auditPool = new Pool({ connectionString: AUDIT_URL as string, max: 3 });
    auditPool.on("connect", (c) => {
      void c.query(`SET search_path TO ${schema}, public`);
    });
  }, 60_000);

  afterAll(async () => {
    if (auditPool !== null) await auditPool.end();
    if (h !== null) await h.cleanup();
  });

  it("emits a real audit event through the real role, including the hash-chain predecessor read", async () => {
    if (h === null || auditPool === null) return;
    const tenantId = newTenantId();
    const emitter = new PostgresAuditEmitter(auditPool);

    const first = await emitter.emit({
      tenantId,
      layer: "identity",
      actor: "proof-actor",
      action: "auth.login",
      inputs: {},
      outputs: {},
    });
    expect(first.prevEventHash).toBeNull();
    expect(first.eventHash).toBeTruthy();

    // A second emit for the SAME tenant only chains correctly if the
    // predecessor SELECT actually ran (not merely permitted) -- this is the
    // genuine end-to-end proof, not just "insert succeeded".
    const second = await emitter.emit({
      tenantId,
      layer: "identity",
      actor: "proof-actor",
      action: "auth.password_set",
      inputs: {},
      outputs: {},
    });
    expect(second.prevEventHash).toBe(first.eventHash);
  });

  it("still cannot mutate an existing row (append-only holds under the widened grant)", async () => {
    if (h === null || auditPool === null) return;
    const tenantId = newTenantId();
    const emitter = new PostgresAuditEmitter(auditPool);
    await emitter.emit({
      tenantId,
      layer: "identity",
      actor: "proof-actor",
      action: "auth.login",
      inputs: {},
      outputs: {},
    });
    await expect(
      auditPool.query("UPDATE audit_events SET actor = 'tampered' WHERE tenant_id = $1", [
        tenantId,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});
