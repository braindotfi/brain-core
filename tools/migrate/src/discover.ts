/**
 * Migration discovery.
 *
 * A Brain migration file lives at `services/<service>/migrations/NNNN_name.sql`
 * where NNNN is a zero-padded sequence number (string-sortable). The runner
 * applies migrations in per-service order, serialized across services by file
 * name to keep global ordering deterministic — two services' migration 0001
 * apply in lexicographic service-name order.
 *
 * §10.5: migrations are forward-compatible, authored in `services/*\/migrations/`,
 * executed by this binary.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";

export interface DiscoveredMigration {
  /** Service owning the migration. Derived from the path `services/<svc>/...`. */
  service: string;
  /** File basename, e.g. `0001_audit_events.sql`. */
  name: string;
  /** Zero-padded sequence number parsed from the prefix. */
  sequence: string;
  /** Absolute path. */
  path: string;
  /** SQL content. */
  sql: string;
  /** Stable sort key: `{service}/{name}`. */
  key: string;
}

const FILENAME_RE = /^(\d{4,})_[a-z0-9_]+\.sql$/i;

export async function discoverMigrations(repoRoot: string): Promise<DiscoveredMigration[]> {
  const servicesDir = join(repoRoot, "services");
  const services = await safeListDirs(servicesDir);
  const results: DiscoveredMigration[] = [];

  for (const service of services) {
    const mDir = join(servicesDir, service, "migrations");
    const exists = await pathExists(mDir);
    if (!exists) continue;
    const files = (await readdir(mDir)).filter((f) => FILENAME_RE.test(f)).sort();
    for (const name of files) {
      const path = join(mDir, name);
      const sql = await readFile(path, "utf8");
      const matchResult = FILENAME_RE.exec(name);
      if (matchResult === null) continue;
      const sequence = matchResult[1] ?? "";
      results.push({
        service,
        name,
        sequence,
        path,
        sql,
        key: `${service}${sep}${name}`,
      });
    }
  }

  // Stable global order: service ascending, then filename ascending.
  results.sort((a, b) => a.key.localeCompare(b.key));
  return results;
}

async function safeListDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
