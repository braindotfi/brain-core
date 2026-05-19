import { describe, expect, it, vi } from "vitest";
import type { DiscoveredMigration } from "./discover.js";
import { applyAll, contentSha, ensureBookkeeping, status } from "./runner.js";

/** Record every statement the runner issues; let the test reply to SELECTs. */
function makeFakeClient(selectRows: Array<Record<string, unknown>> = []): {
  client: {
    query: ReturnType<typeof vi.fn>;
    connect?: () => Promise<void>;
    end?: () => Promise<void>;
  };
  log: string[];
  setSelectRows(next: Array<Record<string, unknown>>): void;
} {
  const log: string[] = [];
  let rows = selectRows;
  const client = {
    query: vi.fn(async (text: string, _values?: unknown[]) => {
      const summary = text.trim().split("\n")[0]!.trim();
      log.push(summary);
      const upper = text.trim().toUpperCase();
      if (upper.startsWith("SELECT")) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    }),
  };
  return {
    client,
    log,
    setSelectRows(next) {
      rows = next;
    },
  };
}

function m(service: string, name: string, sql: string): DiscoveredMigration {
  return {
    service,
    name,
    sequence: name.slice(0, 4),
    path: `${service}/${name}`,
    sql,
    key: `${service}/${name}`,
  };
}

describe("ensureBookkeeping", () => {
  it("issues CREATE TABLE IF NOT EXISTS brain_migrations", async () => {
    const { client, log } = makeFakeClient();
    await ensureBookkeeping(client);
    expect(log.join(" ")).toContain("CREATE TABLE IF NOT EXISTS brain_migrations");
  });
});

describe("applyAll", () => {
  it("applies pending migrations in order inside BEGIN/COMMIT", async () => {
    const { client, log } = makeFakeClient();
    const ms = [
      m("audit", "0001_audit_events.sql", "-- audit sql"),
      m("raw", "0001_raw_artifacts.sql", "-- raw sql"),
    ];

    const result = await applyAll(client, ms, { appliedBy: "test-user" });
    expect(result.applied.map((x) => x.key)).toEqual(ms.map((x) => x.key));
    expect(result.skipped).toEqual([]);

    // First statement is the bookkeeping CREATE, then SELECT for applied list,
    // then (BEGIN, migration SQL, INSERT brain_migrations, COMMIT) per entry.
    const meaningful = log.filter(
      (l) => !l.startsWith("SELECT") && !l.includes("CREATE TABLE IF NOT EXISTS brain_migrations"),
    );
    expect(meaningful[0]).toBe("BEGIN");
    expect(meaningful[1]).toBe("-- audit sql");
    expect(meaningful[2]).toContain("INSERT INTO brain_migrations");
    expect(meaningful[3]).toBe("COMMIT");
    expect(meaningful[4]).toBe("BEGIN");
    expect(meaningful[5]).toBe("-- raw sql");
  });

  it("skips migrations already applied with matching content hash", async () => {
    const sql = "-- unchanged";
    const applied = [
      {
        key: "audit/0001_audit_events.sql",
        service: "audit",
        name: "0001_audit_events.sql",
        sequence: "0001",
        content_sha: contentSha(sql),
        applied_at: new Date(),
        applied_by: "prev",
      },
    ];
    const { client } = makeFakeClient(applied as unknown as Array<Record<string, unknown>>);
    const result = await applyAll(client, [m("audit", "0001_audit_events.sql", sql)]);
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((x) => x.key)).toEqual(["audit/0001_audit_events.sql"]);
  });

  it("throws on content drift (applied hash differs from discovered)", async () => {
    const applied = [
      {
        key: "audit/0001_audit_events.sql",
        service: "audit",
        name: "0001_audit_events.sql",
        sequence: "0001",
        content_sha: contentSha("original"),
        applied_at: new Date(),
        applied_by: "prev",
      },
    ];
    const { client } = makeFakeClient(applied as unknown as Array<Record<string, unknown>>);
    await expect(
      applyAll(client, [m("audit", "0001_audit_events.sql", "MUTATED")]),
    ).rejects.toThrow(/different content hash/);
  });

  it("rolls back and reports the failing migration on SQL error", async () => {
    const log: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        const upper = text.trim().toUpperCase();
        log.push(text.trim().split("\n")[0]!.trim());
        if (upper.startsWith("SELECT")) return { rows: [], rowCount: 0 };
        if (text.includes("DROP BAD")) throw new Error("syntax error");
        return { rows: [], rowCount: 0 };
      }),
    };
    await expect(applyAll(client, [m("raw", "0001_broken.sql", "DROP BAD;")])).rejects.toThrow(
      /migration raw\/0001_broken\.sql failed: syntax error/,
    );
    expect(log).toContain("ROLLBACK");
  });
});

describe("status", () => {
  it("classifies each discovered migration as pending / applied / drifted", async () => {
    const appliedOk = "-- applied";
    const applied = [
      {
        key: "audit/0001_audit_events.sql",
        service: "audit",
        name: "0001_audit_events.sql",
        sequence: "0001",
        content_sha: contentSha(appliedOk),
        applied_at: new Date(),
        applied_by: "prev",
      },
      {
        key: "raw/0001_raw_artifacts.sql",
        service: "raw",
        name: "0001_raw_artifacts.sql",
        sequence: "0001",
        content_sha: contentSha("ORIGINAL"),
        applied_at: new Date(),
        applied_by: "prev",
      },
    ];
    const { client } = makeFakeClient(applied as unknown as Array<Record<string, unknown>>);
    const result = await status(client, [
      m("audit", "0001_audit_events.sql", appliedOk),
      m("raw", "0001_raw_artifacts.sql", "CHANGED"),
      m("wiki", "0001_entities.sql", "-- new"),
    ]);
    expect(result.map((r) => r.state)).toEqual(["applied", "drifted", "pending"]);
  });
});
