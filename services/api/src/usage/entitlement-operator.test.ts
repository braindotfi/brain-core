import { describe, expect, it } from "vitest";
import { InMemoryAuditEmitter } from "@brain/shared";
import { applyEntitlementChange, emitEntitlementChangeAudit } from "./entitlement-operator.js";

const operatorActor = ["github", "sanket"].join(":");

function operatorPool(options: { tierKeyLimit?: number; existingChange?: boolean } = {}) {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("FROM api_entitlement_change_log")) {
        return options.existingChange
          ? {
              rows: [
                {
                  id: "echg_existing",
                  tenant_id: TENANT_ID,
                  environment: "live",
                  key_id: null,
                  change_type: "tier_assigned",
                  before_state: { tier_id: "starter_v1" },
                  after_state: { tier_id: "standard_v1" },
                  actor: operatorActor,
                  reason: "approved commercial change",
                },
              ],
            }
          : { rows: [] };
      }
      if (sql.includes("FROM api_rate_limit_tiers")) return { rows: [{ id: "standard_v1" }] };
      if (sql.includes("FROM tenant_api_entitlements") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              tier_id: "starter_v1",
              version: 1,
              status: "active",
              effective_at: "2026-09-01T00:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("UPDATE tenant_api_entitlements")) {
        return {
          rows: [
            {
              tier_id: "standard_v1",
              version: 2,
              status: "active",
              effective_at: "2026-09-02T00:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("SELECT id, environment FROM api_keys")) {
        return { rows: [{ id: KEY_ID, environment: "live" }] };
      }
      if (sql.includes("FROM api_key_rate_limit_overrides") && sql.includes("FOR UPDATE")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT tier.key_limit")) {
        return { rows: [{ key_limit: options.tierKeyLimit ?? 300 }] };
      }
      if (sql.includes("INSERT INTO api_key_rate_limit_overrides")) {
        return { rows: [{ key_limit: 100, version: 1, expires_at: null }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as never, queries };
}

const TENANT_ID = "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ";
const KEY_ID = "akey_01M0KHRVY3RT3EXN7WT2SPDFMZ";
const base = {
  tenantId: TENANT_ID,
  environment: "live" as const,
  idempotencyKey: "github-run-123-1",
  actor: operatorActor,
  reason: "approved commercial change",
};

describe("entitlement operator control plane", () => {
  it("changes a tier and appends same-transaction immutable evidence", async () => {
    const { pool, queries } = operatorPool();
    const change = await applyEntitlementChange(pool, {
      ...base,
      action: { type: "assign_tier", tierId: "standard_v1" },
    });

    expect(change).toMatchObject({
      changeType: "tier_assigned",
      beforeState: { tier_id: "starter_v1", version: 1 },
      afterState: { tier_id: "standard_v1", version: 2 },
    });
    const mutationIndex = queries.findIndex(({ sql }) =>
      sql.includes("UPDATE tenant_api_entitlements"),
    );
    const evidenceIndex = queries.findIndex(({ sql }) =>
      sql.includes("INSERT INTO api_entitlement_change_log"),
    );
    const commitIndex = queries.findIndex(({ sql }) => sql === "COMMIT");
    expect(mutationIndex).toBeGreaterThan(-1);
    expect(evidenceIndex).toBeGreaterThan(mutationIndex);
    expect(commitIndex).toBeGreaterThan(evidenceIndex);
  });

  it("permits only a restrictive key override", async () => {
    const { pool } = operatorPool({ tierKeyLimit: 300 });
    await expect(
      applyEntitlementChange(pool, {
        ...base,
        action: { type: "set_key_override", keyId: KEY_ID, keyLimit: 301, expiresAt: null },
      }),
    ).rejects.toThrow("cannot raise");

    const allowed = await applyEntitlementChange(pool, {
      ...base,
      idempotencyKey: "github-run-124-1",
      action: { type: "set_key_override", keyId: KEY_ID, keyLimit: 100, expiresAt: null },
    });
    expect(allowed).toMatchObject({
      keyId: KEY_ID,
      changeType: "key_override_set",
      afterState: { key_limit: 100 },
    });
  });

  it("reuses an existing change idempotently without another mutation", async () => {
    const { pool, queries } = operatorPool({ existingChange: true });
    const change = await applyEntitlementChange(pool, {
      ...base,
      action: { type: "assign_tier", tierId: "standard_v1" },
    });
    expect(change.id).toBe("echg_existing");
    expect(queries.some(({ sql }) => sql.includes("UPDATE tenant_api_entitlements"))).toBe(false);
  });

  it("emits a tenant audit event with before and after state", async () => {
    const audit = new InMemoryAuditEmitter();
    await emitEntitlementChangeAudit(audit, {
      id: "echg_test",
      tenantId: TENANT_ID,
      environment: "live",
      keyId: null,
      changeType: "tier_assigned",
      beforeState: { tier_id: "starter_v1" },
      afterState: { tier_id: "standard_v1" },
      actor: operatorActor,
      reason: "approved commercial change",
    });
    expect(audit.events[0]).toMatchObject({
      action: "api_entitlement.tier_assigned",
      actor: operatorActor,
      beforeState: { tier_id: "starter_v1" },
      afterState: { tier_id: "standard_v1" },
      idempotencyKey: "api-entitlement-change:echg_test",
    });
  });
});
