import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverMigrations } from "./discover.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "brain-migrate-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("discoverMigrations", () => {
  it("discovers per-service migrations in stable global order", async () => {
    await writeSql(root, "audit", "0001_audit_events.sql", "CREATE TABLE audit_events();");
    await writeSql(root, "raw", "0001_raw_artifacts.sql", "CREATE TABLE raw_artifacts();");
    await writeSql(root, "raw", "0002_raw_parsed.sql", "CREATE TABLE raw_parsed();");

    const found = await discoverMigrations(root);
    expect(found.map((m) => m.key)).toEqual([
      join("audit", "0001_audit_events.sql"),
      join("raw", "0001_raw_artifacts.sql"),
      join("raw", "0002_raw_parsed.sql"),
    ]);
    expect(found[0]?.sequence).toBe("0001");
    expect(found[0]?.service).toBe("audit");
    expect(found[2]?.sql).toContain("CREATE TABLE raw_parsed");
  });

  it("ignores non-SQL files and malformed names", async () => {
    await writeSql(root, "raw", "0001_ok.sql", "-- ok");
    await writeSql(root, "raw", "README.md", "docs");
    await writeSql(root, "raw", "not_prefixed.sql", "-- bad");
    await writeSql(root, "raw", "1_too_short.sql", "-- bad");
    const found = await discoverMigrations(root);
    expect(found.map((m) => m.name)).toEqual(["0001_ok.sql"]);
  });

  it("returns empty when services/ is absent", async () => {
    expect(await discoverMigrations(root)).toEqual([]);
  });

  it("skips services that have no migrations dir", async () => {
    await mkdir(join(root, "services", "raw"), { recursive: true });
    await writeSql(root, "wiki", "0001_entities.sql", "-- wiki");
    const found = await discoverMigrations(root);
    expect(found.map((m) => m.service)).toEqual(["wiki"]);
  });
});

async function writeSql(root: string, service: string, file: string, sql: string): Promise<void> {
  const dir = join(root, "services", service, "migrations");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), sql);
}
