import { Pool } from "pg";
import { PostgresAuditEmitter } from "@brain/shared";
import {
  addUsageAdjustment,
  closeShadowUsagePeriod,
  reconcileUsagePeriod,
} from "./billing-service.js";

type Flags = Record<string, string>;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "reconcile" && command !== "close-shadow" && command !== "adjust") {
    throw new Error("usage: billing-operator <reconcile|close-shadow|adjust> [flags]");
  }
  const flags = parseFlags(rest);
  const tenantId = required(flags, "tenant-id");
  const environment = requiredEnvironment(flags);
  const actor = required(flags, "actor");
  const reason = required(flags, "reason");
  if (!/^github:[A-Za-z0-9-]{1,39}$/.test(actor)) throw new Error("invalid GitHub actor");
  if (reason.length < 10 || reason.length > 240 || /[\r\n]/.test(reason)) {
    throw new Error("reason must be 10 to 240 characters on one line");
  }
  const privilegedPool = new Pool({ connectionString: requiredEnv("DATABASE_URL") });
  const auditPool = new Pool({ connectionString: requiredEnv("BRAIN_AUDIT_DATABASE_URL") });
  const audit = new PostgresAuditEmitter(auditPool);
  try {
    if (command === "reconcile") {
      const result = await reconcileUsagePeriod(privilegedPool, {
        tenantId,
        environment,
        periodStart: requiredDate(flags, "period-start"),
        periodEnd: requiredDate(flags, "period-end"),
        idempotencyKey: required(flags, "idempotency-key"),
        actor,
      });
      await audit.emit({
        tenantId,
        layer: "audit",
        actor,
        action: "api_usage.reconciled",
        inputs: { environment, reason },
        outputs: { reconciliation_run_id: result.id, status: result.status },
        idempotencyKey: `api-usage-reconciliation:${result.id}`,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "close-shadow") {
      const result = await closeShadowUsagePeriod(privilegedPool, {
        tenantId,
        environment,
        reconciliationRunId: required(flags, "reconciliation-run-id"),
        actor,
        reason,
      });
      await audit.emit({
        tenantId,
        layer: "audit",
        actor,
        action: "api_usage.shadow_period_closed",
        inputs: { environment, reason },
        outputs: { billing_period_id: result.id, chargeable_units: 0 },
        idempotencyKey: `api-usage-period-close:${result.id}`,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const result = await addUsageAdjustment(privilegedPool, {
      tenantId,
      billingPeriodId: required(flags, "billing-period-id"),
      unitDelta: signedInteger(flags, "unit-delta"),
      reason,
      actor,
    });
    await audit.emit({
      tenantId,
      layer: "audit",
      actor,
      action: "api_usage.adjustment_recorded",
      inputs: { billing_period_id: required(flags, "billing-period-id"), reason },
      outputs: { adjustment_id: result.id, unit_delta: signedInteger(flags, "unit-delta") },
      idempotencyKey: `api-usage-adjustment:${result.id}`,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await Promise.all([privilegedPool.end(), auditPool.end()]);
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

function requiredDate(flags: Flags, name: string): Date {
  const value = new Date(required(flags, name));
  if (!Number.isFinite(value.getTime())) throw new Error(`--${name} must be an ISO timestamp`);
  return value;
}

function signedInteger(flags: Flags, name: string): number {
  const value = Number(required(flags, name));
  if (!Number.isSafeInteger(value) || value === 0) throw new Error(`--${name} must be nonzero`);
  return value;
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
