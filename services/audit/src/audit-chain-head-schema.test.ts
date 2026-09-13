import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (name: string): string =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

const HEADS = migration("0025_audit_chain_heads.sql");
const BACKFILL = migration("0026_backfill_audit_chain_heads.sql");
const PREFLIGHT = migration("0027_audit_chain_constraint_preflight.sql");
const GENESIS = migration("0028_audit_chain_genesis_constraint.sql");
const SUCCESSOR = migration("0029_audit_chain_successor_constraint.sql");
const EMITTER = readFileSync(
  new URL("../../../shared/src/audit/emitter.ts", import.meta.url),
  "utf8",
);

describe("authoritative audit chain head schema", () => {
  it("stores one forced-RLS head per tenant and advances it by compare and swap", () => {
    expect(HEADS).toContain("CREATE TABLE audit_chain_heads");
    expect(HEADS).toContain("tenant_id         TEXT PRIMARY KEY");
    expect(HEADS).toContain("sequence          BIGINT NOT NULL DEFAULT 0");
    expect(HEADS).toContain("ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY");
    expect(HEADS).toContain("CREATE TRIGGER audit_events_advance_chain_head");
    expect(HEADS).toContain("head_event_hash IS NOT DISTINCT FROM $4");
    expect(HEADS).toContain(
      "audit event predecessor does not match authoritative tenant chain head",
    );
  });

  it("backfills graph tails without timestamp or identifier ordering", () => {
    expect(BACKFILL).toContain("INSERT INTO audit_chain_heads");
    expect(BACKFILL).toContain("successor.prev_event_hash = event.event_hash");
    expect(BACKFILL).not.toMatch(/ORDER BY\s+created_at/i);
    expect(BACKFILL).not.toMatch(/ORDER BY\s+id/i);
  });

  it("fails migration preflight on forks, gaps, genesis errors, or stale heads", () => {
    expect(PREFLIGHT).toContain("HAVING count(*) > 1");
    expect(PREFLIGHT).toContain("preflight found a missing predecessor");
    expect(PREFLIGHT).toContain("HAVING count(*) FILTER (WHERE prev_event_hash IS NULL) <> 1");
    expect(PREFLIGHT).toContain("preflight found an invalid authoritative head");
  });

  it("installs both uniqueness constraints without blocking the append path", () => {
    expect(GENESIS).toMatch(/^-- brain-migration: no-transaction/);
    expect(GENESIS).toContain("CREATE UNIQUE INDEX CONCURRENTLY");
    expect(GENESIS).toContain("uq_audit_events_one_genesis_per_tenant");
    expect(GENESIS).toContain("WHERE prev_event_hash IS NULL");
    expect(SUCCESSOR).toMatch(/^-- brain-migration: no-transaction/);
    expect(SUCCESSOR).toContain("CREATE UNIQUE INDEX CONCURRENTLY");
    expect(SUCCESSOR).toContain("uq_audit_events_one_successor_per_predecessor");
    expect(SUCCESSOR).toContain("WHERE prev_event_hash IS NOT NULL");
  });

  it("removes timestamp and random-ID tail discovery from the emitter", () => {
    expect(EMITTER).toContain("FROM audit_chain_heads");
    expect(EMITTER).not.toMatch(
      /FROM audit_events[\s\S]{0,200}ORDER BY created_at DESC, id DESC[\s\S]{0,80}LIMIT 1/,
    );
  });
});
