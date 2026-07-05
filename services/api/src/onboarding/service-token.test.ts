import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import { newTenantId } from "@brain/shared";
import { ensureTenantBootstrapped, SERVICE_TOKEN_SCOPES } from "./service-token.js";

interface Captured {
  sql: string;
  values: unknown[];
}

/** Fake tenant-scoped client that records every statement. No active member
 * exists yet, so the bootstrap path always runs (matches a fresh mint). */
function makeFakeClient(opts: { hasActiveMember?: boolean } = {}): {
  client: TenantScopedClient;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      if (sql.includes("SELECT id FROM members")) {
        return Promise.resolve({
          rows: opts.hasActiveMember ? [{ id: "mbr_existing" }] : [],
          rowCount: opts.hasActiveMember ? 1 : 0,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  } as unknown as TenantScopedClient;
  return { client, calls };
}

describe("ensureTenantBootstrapped, H1 fix for POST /v1/auth/service-token", () => {
  it("seeds an owner user, a bootstrap admin member, and an active default policy", async () => {
    const tenantId = newTenantId();
    const { client, calls } = makeFakeClient();

    await ensureTenantBootstrapped(client, tenantId);

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => /INSERT INTO users/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO members/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO policies/.test(s))).toBe(true);

    const memberInsert = calls.find((c) => /INSERT INTO members/.test(c.sql));
    expect(memberInsert?.values).toContain(tenantId);
    // active admin, matching the bootstrap-member helper's fixed shape.
    expect(memberInsert?.sql).toContain("'admin'");
    expect(memberInsert?.sql).toContain("true");

    const policyInsert = calls.find((c) => /INSERT INTO policies/.test(c.sql));
    expect(policyInsert?.sql).toContain("'active'");
    expect(policyInsert?.values).toContain(tenantId);

    const userInsert = calls.find((c) => /INSERT INTO users/.test(c.sql));
    expect(userInsert?.values).toContain(tenantId);
    // password_hash is never inserted: this owner is approval-only, so it
    // must be excluded from the global users_login_email_unique index.
    expect(userInsert?.sql).not.toMatch(/password_hash/);
  });

  it("is a no-op when the tenant already has an active member (repeat mint)", async () => {
    const tenantId = newTenantId();
    const { client, calls } = makeFakeClient({ hasActiveMember: true });

    await ensureTenantBootstrapped(client, tenantId);

    expect(calls.some((c) => /INSERT INTO users/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /INSERT INTO members/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /INSERT INTO policies/.test(c.sql))).toBe(false);
  });
});

describe("SERVICE_TOKEN_SCOPES, M1 fix for POST /v1/auth/service-token", () => {
  it("includes reads + propose but excludes approve/execute/sign/write/admin", () => {
    expect(SERVICE_TOKEN_SCOPES).toContain("payment_intent:propose");
    expect(SERVICE_TOKEN_SCOPES).not.toContain("payment_intent:approve");
    expect(SERVICE_TOKEN_SCOPES).not.toContain("payment_intent:execute");
    expect(SERVICE_TOKEN_SCOPES).not.toContain("policy:write");
    expect(SERVICE_TOKEN_SCOPES).not.toContain("audit:admin");
  });
});
