import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { MigrationBaseline } from "./baselines.js";
import { MIGRATION_BASELINES } from "./baselines.js";
import { discoverMigrations, type DiscoveredMigration } from "./discover.js";
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

describe("advisory lock", () => {
  it("acquires the lock before any work and releases it after", async () => {
    const { client, log } = makeFakeClient();
    await applyAll(client, [m("audit", "0001_audit_events.sql", "-- audit sql")]);

    const lockIdx = log.findIndex((l) =>
      l.includes("pg_advisory_lock(hashtext('brain_migrations')"),
    );
    const unlockIdx = log.findIndex((l) =>
      l.includes("pg_advisory_unlock(hashtext('brain_migrations')"),
    );
    const createIdx = log.findIndex((l) =>
      l.includes("CREATE TABLE IF NOT EXISTS brain_migrations"),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(unlockIdx).toBeGreaterThanOrEqual(0);
    // lock first, bookkeeping after, unlock last.
    expect(lockIdx).toBeLessThan(createIdx);
    expect(unlockIdx).toBeGreaterThan(createIdx);
  });

  it("releases the lock even when a migration fails", async () => {
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
      /migration raw\/0001_broken\.sql failed/,
    );
    expect(log.some((l) => l.includes("pg_advisory_unlock(hashtext('brain_migrations')"))).toBe(
      true,
    );
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

describe("applyAll baselines", () => {
  const baselineMigration = m(
    "ledger",
    "0099_unsupported_here.sql",
    "ALTER SOMETHING UNSUPPORTED;",
  );
  const baseline: MigrationBaseline = {
    key: baselineMigration.key,
    reason: "test fixture: statement unsupported on some platform",
    guard: "SELECT EXISTS (SELECT 1 FROM guard_probe) AS ok",
  };

  it("baselines a pending migration when the guard is TRUE, without running its SQL", async () => {
    const log: string[] = [];
    const calls: Array<{ text: string; values?: ReadonlyArray<unknown> }> = [];
    const client = {
      query: vi.fn(async (text: string, values?: ReadonlyArray<unknown>) => {
        const trimmed = text.trim();
        log.push(trimmed.split("\n")[0]!.trim());
        calls.push({ text: trimmed, values });
        if (trimmed.startsWith("SELECT key, service, name, sequence")) {
          return { rows: [], rowCount: 0 };
        }
        if (trimmed === baseline.guard.trim()) {
          return { rows: [{ ok: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const result = await applyAll(client, [baselineMigration], {
      appliedBy: "test-user",
      baselines: [baseline],
    });

    expect(result.baselined.map((x) => x.key)).toEqual([baselineMigration.key]);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);

    // The migration's own SQL must never be sent to the database.
    expect(log).not.toContain(baselineMigration.sql);

    const insertCall = calls.find((c) => c.text.startsWith("INSERT INTO brain_migrations"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.values).toEqual([
      baselineMigration.key,
      baselineMigration.service,
      baselineMigration.name,
      baselineMigration.sequence,
      contentSha(baselineMigration.sql),
      "test-user",
    ]);
  });

  it("falls through to applying the migration normally when the guard is FALSE", async () => {
    const log: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        const trimmed = text.trim();
        log.push(trimmed.split("\n")[0]!.trim());
        if (trimmed.startsWith("SELECT key, service, name, sequence")) {
          return { rows: [], rowCount: 0 };
        }
        if (trimmed === baseline.guard.trim()) {
          return { rows: [{ ok: false }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const result = await applyAll(client, [baselineMigration], { baselines: [baseline] });

    expect(result.applied.map((x) => x.key)).toEqual([baselineMigration.key]);
    expect(result.baselined).toEqual([]);
    expect(log).toContain(baselineMigration.sql);
  });

  it("still skips an already-applied migration with a matching hash, without consulting the guard", async () => {
    let guardCalled = false;
    const appliedRow = {
      key: baselineMigration.key,
      service: baselineMigration.service,
      name: baselineMigration.name,
      sequence: baselineMigration.sequence,
      content_sha: contentSha(baselineMigration.sql),
      applied_at: new Date(),
      applied_by: "prev",
    };
    const client = {
      query: vi.fn(async (text: string) => {
        const trimmed = text.trim();
        if (trimmed.startsWith("SELECT key, service, name, sequence")) {
          return { rows: [appliedRow], rowCount: 1 };
        }
        if (trimmed === baseline.guard.trim()) {
          guardCalled = true;
          return { rows: [{ ok: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const result = await applyAll(client, [baselineMigration], { baselines: [baseline] });

    expect(result.skipped.map((x) => x.key)).toEqual([baselineMigration.key]);
    expect(result.baselined).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(guardCalled).toBe(false);
  });

  it("still throws on hash drift for an already-applied migration with a baseline entry", async () => {
    const appliedRow = {
      key: baselineMigration.key,
      service: baselineMigration.service,
      name: baselineMigration.name,
      sequence: baselineMigration.sequence,
      content_sha: contentSha("original content"),
      applied_at: new Date(),
      applied_by: "prev",
    };
    const client = {
      query: vi.fn(async (text: string) => {
        const trimmed = text.trim();
        if (trimmed.startsWith("SELECT key, service, name, sequence")) {
          return { rows: [appliedRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    await expect(
      applyAll(client, [m(baselineMigration.service, baselineMigration.name, "MUTATED content")], {
        baselines: [baseline],
      }),
    ).rejects.toThrow(/different content hash/);
  });
});

describe("status baselines", () => {
  it("reports baselined for a pending migration whose guard currently passes", async () => {
    const baselineMigration = m(
      "ledger",
      "0099_unsupported_here.sql",
      "ALTER SOMETHING UNSUPPORTED;",
    );
    const baseline: MigrationBaseline = {
      key: baselineMigration.key,
      reason: "test fixture",
      guard: "SELECT EXISTS (SELECT 1 FROM guard_probe) AS ok",
    };
    const client = {
      query: vi.fn(async (text: string) => {
        const trimmed = text.trim();
        if (trimmed.startsWith("SELECT key, service, name, sequence")) {
          return { rows: [], rowCount: 0 };
        }
        if (trimmed === baseline.guard.trim()) {
          return { rows: [{ ok: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const result = await status(client, [baselineMigration], { baselines: [baseline] });
    expect(result.map((r) => r.state)).toEqual(["baselined"]);
  });
});

describe("MIGRATION_BASELINES", () => {
  it("declares only keys that match an actual discovered migration", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const discovered = await discoverMigrations(repoRoot);
    const discoveredKeys = new Set(discovered.map((d) => d.key));
    for (const baseline of MIGRATION_BASELINES) {
      expect(discoveredKeys.has(baseline.key)).toBe(true);
    }
  });
});
