#!/usr/bin/env node
/**
 * brain-migrate CLI.
 *
 * Usage:
 *   brain-migrate up       — apply all pending migrations
 *   brain-migrate status   — print applied/pending/drifted per migration
 *
 * DATABASE_URL is required.
 *
 * Exit codes:
 *   0  success
 *   1  DATABASE_URL missing or invalid
 *   2  migration failed (reason on stderr)
 *   3  drift detected during `status`
 */

import { Client } from "pg";
import { discoverMigrations } from "./discover.js";
import { applyAll, status } from "./runner.js";

async function main(): Promise<number> {
  const [, , cmd] = process.argv;
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl === "") {
    process.stderr.write("error: DATABASE_URL required\n");
    return 1;
  }

  const repoRoot = process.env.BRAIN_REPO_ROOT ?? findRepoRoot();
  const migrations = await discoverMigrations(repoRoot);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    switch (cmd) {
      case "up": {
        const { applied, skipped } = await applyAll(client, migrations);
        for (const m of applied) process.stdout.write(`applied: ${m.key}\n`);
        for (const m of skipped) process.stdout.write(`skipped: ${m.key}\n`);
        return 0;
      }
      case "status": {
        const s = await status(client, migrations);
        let drifted = 0;
        for (const { migration, state } of s) {
          process.stdout.write(`${state.padEnd(8)} ${migration.key}\n`);
          if (state === "drifted") drifted += 1;
        }
        return drifted > 0 ? 3 : 0;
      }
      default:
        process.stderr.write(`usage: brain-migrate <up|status>\n`);
        return 1;
    }
  } finally {
    await client.end();
  }
}

function findRepoRoot(): string {
  // The CLI runs from within a monorepo via pnpm; cwd is normally the repo
  // root. If not, operators can set BRAIN_REPO_ROOT.
  return process.cwd();
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
