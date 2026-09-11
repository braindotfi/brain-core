import { lstat, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { assertEntitlementOperatorRole } from "../usage/entitlement-operator.js";
import {
  commitCommercialShadowStart,
  inspectCommercialShadow,
  prepareCommercialShadowStart,
  transitionCommercialShadow,
} from "./shadow-operator.js";

type Flags = Record<string, string>;

async function main(): Promise<void> {
  const [rawCommand, ...rest] = process.argv.slice(2);
  if (!isCommand(rawCommand)) {
    throw new Error("usage: commercial-shadow-operator <inspect|start|pause|stop|complete>");
  }
  const command = rawCommand;
  const flags = parseFlags(rest);
  const pool = new Pool({ connectionString: requiredEnv("DATABASE_URL") });
  try {
    await assertEntitlementOperatorRole(pool);
    if (command === "inspect") {
      process.stdout.write(`${JSON.stringify(await inspectCommercialShadow(pool))}\n`);
      return;
    }
    const common = {
      approvedSha: required(flags, "approved-sha"),
      actor: required(flags, "actor"),
      reason: required(flags, "reason"),
    };
    if (command === "start") {
      const current = await inspectCommercialShadow(pool);
      if (current["state"] === "paused") {
        const resumed = await transitionCommercialShadow(pool, { ...common, action: "resume" });
        process.stdout.write(`${JSON.stringify({ status: "resumed", ...resumed })}\n`);
        return;
      }
      if (current["state"] !== "not_started") {
        throw new Error("start requires no shadow or a paused shadow");
      }
      const outputDir = resolve(required(flags, "credential-output-dir"));
      const temporaryPath = resolve(outputDir, `.credentials-${process.pid}.tmp`);
      const finalPath = resolve(outputDir, "credentials.json");
      await assertPathAbsent(finalPath);
      const prepared = prepareCommercialShadowStart({
        ...common,
        agentApiKeyPepper: requiredEnv("BRAIN_AGENT_API_KEY_PEPPER"),
        apiKeyPepper: requiredEnv("BRAIN_API_KEY_PEPPER"),
      });
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        try {
          await handle.writeFile(`${JSON.stringify(prepared.bundle)}\n`, { encoding: "utf8" });
          await handle.sync();
        } finally {
          await handle.close();
        }
        const started = await commitCommercialShadowStart(pool, prepared);
        await rename(temporaryPath, finalPath);
        process.stdout.write(
          `${JSON.stringify({
            status: "started",
            tenant_id: started.bundle.tenant_id,
            shadow_period_id: started.bundle.shadow_period_id,
            agent_id: started.bundle.agent_id,
            agent_key_id: started.bundle.agent_key_id,
            api_key_id: started.bundle.api_key_id,
            started_at: started.startedAt,
            credential_file_mode: "0600",
          })}\n`,
        );
      } catch (error) {
        const currentAfterFailure = await inspectCommercialShadow(pool).catch(() => ({
          state: "not_started",
        }));
        if (currentAfterFailure["state"] === "not_started") {
          await unlink(temporaryPath).catch(() => undefined);
        } else if (currentAfterFailure["state"] === "running") {
          await transitionCommercialShadow(pool, {
            ...common,
            action: "pause",
            reason: "Automatic pause because secure credential finalization failed",
          });
        }
        throw error;
      }
      return;
    }
    const transitioned = await transitionCommercialShadow(pool, {
      ...common,
      action: command,
    });
    process.stdout.write(`${JSON.stringify({ status: command, ...transitioned })}\n`);
  } finally {
    await pool.end();
  }
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("credential output already exists");
}

function isCommand(
  value: string | undefined,
): value is "inspect" | "start" | "pause" | "stop" | "complete" {
  return (
    value === "inspect" ||
    value === "start" ||
    value === "pause" ||
    value === "stop" ||
    value === "complete"
  );
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
