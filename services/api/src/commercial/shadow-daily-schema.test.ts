import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../migrations/0044_commercial_shadow_daily_operations.sql", import.meta.url),
  "utf8",
);

describe("commercial shadow Phase 4 schema", () => {
  it("requires exact daily volumes and complete independent evidence", () => {
    expect(migration).toContain("api_completed_requests = api_expected_requests");
    expect(migration).toContain("mcp_completed_requests = mcp_expected_requests");
    expect(migration).toContain("api_evidence_complete = TRUE");
    expect(migration).toContain("mcp_evidence_complete = TRUE");
    expect(migration).toContain("missing_meter_count = 0");
    expect(migration).toContain("unexpected_meter_count = 0");
    expect(migration).toContain("meter_persistence_failures = 0");
  });

  it("defines a side-effect-free previous-day reporting function", () => {
    const functionSql = migration.match(
      /CREATE OR REPLACE FUNCTION report_internal_commercial_shadow_day[\s\S]*?\n\$\$;/,
    )?.[0];
    expect(functionSql).toBeDefined();
    expect(functionSql).toContain("LANGUAGE sql");
    expect(functionSql).toContain("STABLE");
    expect(functionSql).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/);
  });
});
