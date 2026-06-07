/**
 * Operator CLI for the audit-evidence outbox (Codex c96283d P2).
 *
 *   pnpm -C services/api run audit-outbox list \
 *     [--status exhausted|pending|published] [--tenant T] [--limit N]
 *
 *   pnpm -C services/api run audit-outbox replay --operator you@brain \
 *     [--tenant T] [--event-key K] [--id ID] [--older-than SECONDS] [--dry-run] [--limit N]
 *
 * Connects via DATABASE_PRIVILEGED_URL (falls back to DATABASE_URL). `replay` is
 * itself audited (an `audit.outbox.replayed` event per affected tenant). Always
 * `--dry-run` first to see what would be requeued. Runbook:
 * docs/audit-outbox-recovery-runbook.md.
 *
 * This file is a thin entrypoint (excluded from the unit-coverage gate); all
 * logic lives in the tested functions in blob-purge-audit-outbox.ts.
 */

import { Pool } from "pg";
import { PostgresAuditEmitter } from "@brain/shared";
import {
  listAuditOutbox,
  operatorReplayExhaustedAuditOutbox,
  type AuditOutboxFilter,
} from "./blob-purge-audit-outbox.js";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function parseFlags(argv: ReadonlyArray<string>): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function buildFilter(flags: Record<string, string | boolean>): AuditOutboxFilter {
  const olderThan = str(flags["older-than"]);
  return {
    ...(str(flags.tenant) !== undefined ? { tenantId: str(flags.tenant)! } : {}),
    ...(str(flags["event-key"]) !== undefined ? { eventKey: str(flags["event-key"])! } : {}),
    ...(str(flags.id) !== undefined ? { id: str(flags.id)! } : {}),
    ...(olderThan !== undefined ? { olderThanSeconds: Number(olderThan) } : {}),
  };
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const url = process.env.DATABASE_PRIVILEGED_URL ?? process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    console.error("DATABASE_PRIVILEGED_URL (or DATABASE_URL) must be set");
    process.exit(2);
  }

  const limitStr = str(flags.limit);
  const limit = limitStr !== undefined ? Number(limitStr) : undefined;
  const filter = buildFilter(flags);
  const pool = new Pool({ connectionString: url });
  try {
    if (sub === "list") {
      const statusFlag = str(flags.status);
      const status =
        statusFlag === "pending" || statusFlag === "published" || statusFlag === "exhausted"
          ? statusFlag
          : "exhausted";
      const client = await pool.connect();
      try {
        const rows = await listAuditOutbox(client, {
          status,
          filter,
          ...(limit !== undefined ? { limit } : {}),
        });
        out(`${rows.length} ${status} row(s):`);
        for (const r of rows) {
          out(
            `  ${r.id}  tenant=${r.tenant_id}  key=${r.event_key}  ` +
              `action=${r.action}  attempts=${r.attempts}  age=${r.age_seconds}s`,
          );
        }
      } finally {
        client.release();
      }
    } else if (sub === "replay") {
      const operator = str(flags.operator);
      if (operator === undefined) {
        console.error("replay requires --operator <identity>");
        process.exit(2);
      }
      const audit = new PostgresAuditEmitter(pool);
      const res = await operatorReplayExhaustedAuditOutbox(
        { privilegedPool: pool, audit },
        {
          operator,
          filter,
          dryRun: flags["dry-run"] === true,
          ...(limit !== undefined ? { limit } : {}),
        },
      );
      out(`${res.dryRun ? "[dry-run] would replay" : "replayed"} ${res.replayed.length} row(s):`);
      for (const r of res.replayed) {
        out(`  ${r.id}  tenant=${r.tenant_id}  key=${r.event_key}`);
      }
    } else {
      console.error("usage: audit-outbox <list|replay> [flags] (see file header / runbook)");
      process.exit(2);
    }
  } finally {
    await pool.end();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
