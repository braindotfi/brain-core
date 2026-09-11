import { Pool } from "pg";
import { assertEntitlementOperatorRole } from "../usage/entitlement-operator.js";
import {
  readCredentialBundle,
  reportCommercialShadowDay,
  runCommercialShadowDaily,
  writeSchedulerHeartbeat,
} from "./shadow-daily.js";

type Flags = Record<string, string>;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "heartbeat" && command !== "run" && command !== "report") {
    throw new Error("usage: commercial-shadow-daily <heartbeat|run|report>");
  }
  const flags = parseFlags(rest);
  const pool = new Pool({ connectionString: requiredEnv("DATABASE_URL") });
  try {
    await assertEntitlementOperatorRole(pool);
    if (command === "report") {
      process.stdout.write(
        `${JSON.stringify(await reportCommercialShadowDay(pool, required(flags, "date")))}\n`,
      );
      return;
    }
    const deployedSha = required(flags, "deployed-sha");
    if (requiredEnv("GIT_SHA") !== deployedSha) {
      throw new Error("operator image SHA does not match deployed SHA");
    }
    const runReference = required(flags, "run-reference");
    if (command === "heartbeat") {
      const heartbeatState = optional(flags, "state") ?? "ready";
      if (heartbeatState !== "ready" && heartbeatState !== "unhealthy") {
        throw new Error("--state must be ready or unhealthy");
      }
      const state = await pool.query<{ result: Record<string, unknown> }>(
        `SELECT inspect_internal_commercial_shadow() AS result`,
      );
      const current = state.rows[0]?.result;
      if (current?.["state"] === "running") {
        for (const condition of [
          "growth_entitlement_valid",
          "api_rate_entitlement_valid",
          "billing_exclusion_present",
          "zero_billing_state",
          "bff_agent_key_active",
          "commercial_api_key_active",
        ]) {
          if (current[condition] !== true) {
            throw new Error(`scheduler readiness failed: ${condition}`);
          }
        }
        if (current["protected_tenant_match"] !== false) {
          throw new Error("scheduler readiness failed: protected tenant match");
        }
        const provenance = current["provenance"] as Record<string, unknown> | undefined;
        if (
          provenance?.["kind"] !== "production" ||
          provenance["data_profile"] !== "internal_commercial_shadow_v1" ||
          provenance["access_stage"] !== "production"
        ) {
          throw new Error("scheduler readiness failed: tenant provenance");
        }
        const credential = await readCredentialBundle(required(flags, "credential-path"));
        if (
          credential.tenant_id !== current["tenant_id"] ||
          credential.shadow_period_id !== current["shadow_period_id"]
        ) {
          throw new Error("scheduler credential bundle does not match the running shadow");
        }
      }
      await writeSchedulerHeartbeat(pool, {
        deployedSha,
        state: heartbeatState,
        now: new Date(),
        runReference,
      });
      process.stdout.write(`${JSON.stringify({ status: "ready", deployed_sha: deployedSha })}\n`);
      return;
    }
    const result = await runCommercialShadowDaily(pool, {
      deployedSha,
      runReference,
      credentialPath: required(flags, "credential-path"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("flags must use --name value pairs");
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}

function required(flags: Flags, name: string): string {
  const value = flags[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function optional(flags: Flags, name: string): string | undefined {
  const value = flags[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
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
