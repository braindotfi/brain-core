import { Pool } from "pg";
import { PostgresAuditEmitter, withTenantScope } from "@brain/shared";
import { applyEntitlementChange, emitEntitlementChangeAudit } from "./entitlement-operator.js";

type Flags = Record<string, string>;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "inspect" && command !== "apply") {
    throw new Error("usage: entitlement-operator <inspect|apply> [flags]");
  }
  const flags = parseFlags(rest);
  const tenantId = required(flags, "tenant-id");
  const environment = requiredEnvironment(flags);
  const privilegedUrl = requiredEnv("DATABASE_URL");
  const auditUrl = requiredEnv("BRAIN_AUDIT_DATABASE_URL");
  const privilegedPool = new Pool({ connectionString: privilegedUrl });
  const auditPool = new Pool({ connectionString: auditUrl });
  try {
    await assertRole(privilegedPool, "brain_privileged", true);
    await assertRole(auditPool, "brain_app", false);
    if (command === "inspect") {
      const result = await inspectEntitlement(
        privilegedPool,
        tenantId,
        environment,
        flags["key-id"],
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const actor = required(flags, "actor");
    const reason = required(flags, "reason");
    const idempotencyKey = required(flags, "idempotency-key");
    const actionName = required(flags, "action");
    const action =
      actionName === "assign-tier"
        ? { type: "assign_tier" as const, tierId: required(flags, "tier-id") }
        : actionName === "set-key-override"
          ? {
              type: "set_key_override" as const,
              keyId: required(flags, "key-id"),
              keyLimit: positiveInteger(flags, "key-limit"),
              expiresAt: optionalDate(flags["expires-at"]),
            }
          : actionName === "clear-key-override"
            ? { type: "clear_key_override" as const, keyId: required(flags, "key-id") }
            : (() => {
                throw new Error(
                  "action must be assign-tier, set-key-override, or clear-key-override",
                );
              })();
    const change = await applyEntitlementChange(privilegedPool, {
      tenantId,
      environment,
      idempotencyKey,
      actor,
      reason,
      action,
    });
    await emitEntitlementChangeAudit(new PostgresAuditEmitter(auditPool), change);
    process.stdout.write(
      `${JSON.stringify({ status: "applied_and_audited", change_id: change.id, change_type: change.changeType })}\n`,
    );
  } finally {
    await Promise.all([privilegedPool.end(), auditPool.end()]);
  }
}

async function inspectEntitlement(
  pool: Pool,
  tenantId: string,
  environment: "sandbox" | "live",
  keyId: string | undefined,
) {
  return withTenantScope(pool, tenantId, async (client) => {
    const entitlement = await client.query(
      `SELECT ent.tier_id, tier.display_name, ent.version, ent.status,
              tier.window_seconds, tier.key_limit, tier.tenant_limit,
              ent.effective_at, ent.source
         FROM tenant_api_entitlements ent
         JOIN api_rate_limit_tiers tier ON tier.id = ent.tier_id
        WHERE ent.tenant_id = $1 AND ent.environment = $2`,
      [tenantId, environment],
    );
    const override =
      keyId === undefined
        ? { rows: [] }
        : await client.query(
            `SELECT key_id, key_limit, version, expires_at, source, authorized_by
               FROM api_key_rate_limit_overrides
              WHERE tenant_id = $1 AND key_id = $2`,
            [tenantId, keyId],
          );
    return {
      tenant_id: tenantId,
      environment,
      entitlement: entitlement.rows[0] ?? null,
      key_override: override.rows[0] ?? null,
    };
  });
}

async function assertRole(pool: Pool, expected: string, bypassRls: boolean): Promise<void> {
  const { rows } = await pool.query<{ current_user: string; rolbypassrls: boolean }>(
    `SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  const row = rows[0];
  if (row?.current_user !== expected || row.rolbypassrls !== bypassRls) {
    throw new Error(`database role must be ${expected} with rolbypassrls=${String(bypassRls)}`);
  }
}

function parseFlags(args: string[]): Flags {
  const result: Flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("flags must use --name value pairs");
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function required(flags: Flags, name: string): string {
  const value = flags[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function requiredEnvironment(flags: Flags): "sandbox" | "live" {
  const value = required(flags, "environment");
  if (value !== "sandbox" && value !== "live") throw new Error("invalid environment");
  return value;
}

function positiveInteger(flags: Flags, name: string): number {
  const value = Number(required(flags, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be positive`);
  return value;
}

function optionalDate(value: string | undefined): Date | null {
  if (value === undefined || value === "none") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date <= new Date())
    throw new Error("invalid future expiry");
  return date;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
