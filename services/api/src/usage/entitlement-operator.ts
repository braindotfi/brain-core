import type { Pool } from "pg";
import { newApiEntitlementChangeId, withTenantScope, type AuditEmitter } from "@brain/shared";

export type EntitlementOperatorAction =
  | {
      type: "assign_tier";
      tierId: string;
    }
  | {
      type: "set_key_override";
      keyId: string;
      keyLimit: number;
      expiresAt: Date | null;
    }
  | {
      type: "clear_key_override";
      keyId: string;
    };

export interface EntitlementOperatorInput {
  tenantId: string;
  environment: "sandbox" | "live";
  idempotencyKey: string;
  actor: string;
  reason: string;
  action: EntitlementOperatorAction;
}

export interface EntitlementChange {
  id: string;
  tenantId: string;
  environment: "sandbox" | "live";
  keyId: string | null;
  changeType: "tier_assigned" | "key_override_set" | "key_override_cleared";
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  actor: string;
  reason: string;
}

/**
 * Operator-only mutation. The caller must use the protected brain_privileged
 * connection. There is deliberately no member or public HTTP route to this
 * function.
 */
export async function applyEntitlementChange(
  privilegedPool: Pool,
  input: EntitlementOperatorInput,
): Promise<EntitlementChange> {
  validateInput(input);
  return withTenantScope(privilegedPool, input.tenantId, async (client) => {
    const existing = await client.query<{
      id: string;
      tenant_id: string;
      environment: "sandbox" | "live";
      key_id: string | null;
      change_type: EntitlementChange["changeType"];
      before_state: Record<string, unknown>;
      after_state: Record<string, unknown>;
      actor: string;
      reason: string;
    }>(
      `SELECT id, tenant_id, environment, key_id, change_type,
              before_state, after_state, actor, reason
         FROM api_entitlement_change_log
        WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    if (existing.rows[0] !== undefined) return serializeChange(existing.rows[0]);

    let change: Omit<EntitlementChange, "id" | "tenantId" | "environment" | "actor" | "reason">;
    if (input.action.type === "assign_tier") {
      const tier = await client.query<{ id: string }>(
        `SELECT id FROM api_rate_limit_tiers WHERE id = $1`,
        [input.action.tierId],
      );
      if (tier.rows[0] === undefined) throw new Error("rate tier does not exist");
      const current = await client.query<{
        tier_id: string;
        version: number;
        status: string;
        effective_at: Date | string;
      }>(
        `SELECT tier_id, version, status, effective_at
           FROM tenant_api_entitlements
          WHERE tenant_id = $1 AND environment = $2
          FOR UPDATE`,
        [input.tenantId, input.environment],
      );
      const before = current.rows[0];
      if (before === undefined) throw new Error("tenant entitlement does not exist");
      const updated = await client.query<{
        tier_id: string;
        version: number;
        status: string;
        effective_at: Date | string;
      }>(
        `UPDATE tenant_api_entitlements
            SET tier_id = $3, version = version + 1, source = 'operator_workflow',
                effective_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND environment = $2
          RETURNING tier_id, version, status, effective_at`,
        [input.tenantId, input.environment, input.action.tierId],
      );
      change = {
        keyId: null,
        changeType: "tier_assigned",
        beforeState: entitlementState(before),
        afterState: entitlementState(updated.rows[0]!),
      };
    } else {
      const key = await client.query<{ id: string; environment: "sandbox" | "live" }>(
        `SELECT id, environment FROM api_keys
          WHERE id = $1 AND tenant_id = $2
          FOR UPDATE`,
        [input.action.keyId, input.tenantId],
      );
      if (key.rows[0] === undefined || key.rows[0].environment !== input.environment) {
        throw new Error("API key does not belong to the tenant and environment");
      }
      const current = await client.query<{
        key_limit: number;
        version: number;
        expires_at: Date | string | null;
      }>(
        `SELECT key_limit, version, expires_at
           FROM api_key_rate_limit_overrides
          WHERE key_id = $1 AND tenant_id = $2
          FOR UPDATE`,
        [input.action.keyId, input.tenantId],
      );
      const beforeState = overrideState(current.rows[0]);
      if (input.action.type === "set_key_override") {
        const entitlement = await client.query<{ key_limit: number }>(
          `SELECT tier.key_limit
             FROM tenant_api_entitlements ent
             JOIN api_rate_limit_tiers tier ON tier.id = ent.tier_id
            WHERE ent.tenant_id = $1 AND ent.environment = $2`,
          [input.tenantId, input.environment],
        );
        const tierKeyLimit = entitlement.rows[0]?.key_limit;
        if (tierKeyLimit === undefined) throw new Error("tenant entitlement does not exist");
        if (input.action.keyLimit > tierKeyLimit) {
          throw new Error("key override cannot raise the tenant entitlement key limit");
        }
        const updated = await client.query<{
          key_limit: number;
          version: number;
          expires_at: Date | string | null;
        }>(
          `INSERT INTO api_key_rate_limit_overrides (
             key_id, tenant_id, key_limit, version, source, reason,
             authorized_by, effective_at, expires_at
           ) VALUES ($1, $2, $3, 1, 'operator_workflow', $4, $5, now(), $6)
           ON CONFLICT (key_id) DO UPDATE
             SET key_limit = EXCLUDED.key_limit,
                 version = api_key_rate_limit_overrides.version + 1,
                 source = EXCLUDED.source,
                 reason = EXCLUDED.reason,
                 authorized_by = EXCLUDED.authorized_by,
                 effective_at = now(),
                 expires_at = EXCLUDED.expires_at,
                 updated_at = now()
           RETURNING key_limit, version, expires_at`,
          [
            input.action.keyId,
            input.tenantId,
            input.action.keyLimit,
            input.reason,
            input.actor,
            input.action.expiresAt,
          ],
        );
        change = {
          keyId: input.action.keyId,
          changeType: "key_override_set",
          beforeState,
          afterState: overrideState(updated.rows[0]),
        };
      } else {
        await client.query(
          `DELETE FROM api_key_rate_limit_overrides WHERE key_id = $1 AND tenant_id = $2`,
          [input.action.keyId, input.tenantId],
        );
        change = {
          keyId: input.action.keyId,
          changeType: "key_override_cleared",
          beforeState,
          afterState: { override: null },
        };
      }
    }

    const id = newApiEntitlementChangeId();
    const complete: EntitlementChange = {
      id,
      tenantId: input.tenantId,
      environment: input.environment,
      actor: input.actor,
      reason: input.reason,
      ...change,
    };
    await client.query(
      `INSERT INTO api_entitlement_change_log (
         id, idempotency_key, tenant_id, environment, key_id, change_type,
         before_state, after_state, actor, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        complete.id,
        input.idempotencyKey,
        complete.tenantId,
        complete.environment,
        complete.keyId,
        complete.changeType,
        JSON.stringify(complete.beforeState),
        JSON.stringify(complete.afterState),
        complete.actor,
        complete.reason,
      ],
    );
    return complete;
  });
}

export async function emitEntitlementChangeAudit(
  audit: AuditEmitter,
  change: EntitlementChange,
): Promise<void> {
  await audit.emit({
    tenantId: change.tenantId,
    layer: "identity",
    actor: change.actor,
    action: `api_entitlement.${change.changeType}`,
    inputs: {
      environment: change.environment,
      key_id: change.keyId,
      reason: change.reason,
    },
    outputs: { change_id: change.id },
    beforeState: change.beforeState,
    afterState: change.afterState,
    idempotencyKey: `api-entitlement-change:${change.id}`,
  });
}

function validateInput(input: EntitlementOperatorInput): void {
  if (!/^tnt_[0-9A-HJKMNP-TV-Z]{26}$/.test(input.tenantId)) throw new Error("invalid tenant id");
  if (!/^github-run-[0-9]+-[0-9]+$/.test(input.idempotencyKey)) {
    throw new Error("idempotency key must identify a GitHub run and attempt");
  }
  if (!/^github:[A-Za-z0-9-]{1,39}$/.test(input.actor)) throw new Error("invalid GitHub actor");
  if (input.reason.length < 10 || input.reason.length > 240 || /[\r\n]/.test(input.reason)) {
    throw new Error("reason must be 10 to 240 characters on one line");
  }
  if (
    input.action.type === "set_key_override" &&
    (!Number.isSafeInteger(input.action.keyLimit) || input.action.keyLimit <= 0)
  ) {
    throw new Error("key override limit must be a positive safe integer");
  }
}

function entitlementState(row: {
  tier_id: string;
  version: number;
  status: string;
  effective_at: Date | string;
}): Record<string, unknown> {
  return {
    tier_id: row.tier_id,
    version: row.version,
    status: row.status,
    effective_at: new Date(row.effective_at).toISOString(),
  };
}

function overrideState(
  row: { key_limit: number; version: number; expires_at: Date | string | null } | undefined,
): Record<string, unknown> {
  return row === undefined
    ? { override: null }
    : {
        key_limit: row.key_limit,
        version: row.version,
        expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      };
}

function serializeChange(row: {
  id: string;
  tenant_id: string;
  environment: "sandbox" | "live";
  key_id: string | null;
  change_type: EntitlementChange["changeType"];
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  actor: string;
  reason: string;
}): EntitlementChange {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    environment: row.environment,
    keyId: row.key_id,
    changeType: row.change_type,
    beforeState: row.before_state,
    afterState: row.after_state,
    actor: row.actor,
    reason: row.reason,
  };
}
