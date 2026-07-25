import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import { hasValidParsedForArtifact, insertParsed, listParsedByArtifact } from "./parsed.js";

function fakeClient(): { client: TenantScopedClient; log: { sql: string; values: unknown[] }[] } {
  const log: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
      log.push({ sql, values: Array.from(values ?? []) });
      return { rows: [], rowCount: 0 };
    }),
  };
  return { client: client as unknown as TenantScopedClient, log };
}

describe("listParsedByArtifact", () => {
  it("queries by raw_artifact_id with no filters", async () => {
    const { client, log } = fakeClient();
    await listParsedByArtifact(client, "raw_1");
    expect(log[0]!.sql).toContain("raw_artifact_id = $1");
    expect(log[0]!.values).toEqual(["raw_1"]);
  });

  it("adds parser predicate when provided", async () => {
    const { client, log } = fakeClient();
    await listParsedByArtifact(client, "raw_1", { parser: "plaid-v2" });
    expect(log[0]!.sql).toContain("parser = $2");
    expect(log[0]!.values).toEqual(["raw_1", "plaid-v2"]);
  });

  it("adds parserVersion predicate when provided", async () => {
    const { client, log } = fakeClient();
    await listParsedByArtifact(client, "raw_1", { parserVersion: "1.0.0" });
    expect(log[0]!.sql).toContain("parser_version = $2");
    expect(log[0]!.values).toEqual(["raw_1", "1.0.0"]);
  });

  it("adds both parser and parserVersion predicates with correct indices", async () => {
    const { client, log } = fakeClient();
    await listParsedByArtifact(client, "raw_1", { parser: "plaid-v2", parserVersion: "1.0.0" });
    expect(log[0]!.sql).toContain("parser = $2");
    expect(log[0]!.sql).toContain("parser_version = $3");
    expect(log[0]!.values).toEqual(["raw_1", "plaid-v2", "1.0.0"]);
  });

  it("orders by extracted_at DESC", async () => {
    const { client, log } = fakeClient();
    await listParsedByArtifact(client, "raw_1");
    expect(log[0]!.sql).toMatch(/ORDER BY extracted_at DESC/);
  });
});

describe("hasValidParsedForArtifact", () => {
  it("checks for parser-stamped parsed rows", async () => {
    const log: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        return { rows: [{ count: "1" }], rowCount: 1 };
      }),
    } as unknown as TenantScopedClient;

    await expect(hasValidParsedForArtifact(client, "raw_1")).resolves.toBe(true);
    expect(log[0]!.sql).toContain("raw_artifact_id = $1");
    expect(log[0]!.sql).toContain("parser IS NOT NULL");
    expect(log[0]!.values).toEqual(["raw_1"]);
  });

  it("can require an expected parser and exclude stale zero-row projections", async () => {
    const log: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        return { rows: [{ count: "1" }], rowCount: 1 };
      }),
    } as unknown as TenantScopedClient;

    await expect(
      hasValidParsedForArtifact(client, "raw_1", {
        acceptedParsers: ["bank_statement_upload_v1"],
        excludeTerminalZeroProjection: true,
      }),
    ).resolves.toBe(true);
    expect(log[0]!.sql).toContain("rp.parser = ANY($2::text[])");
    expect(log[0]!.sql).toContain("canonical_projection_log");
    expect(log[0]!.sql).toContain("records_written = 0");
    expect(log[0]!.values).toEqual(["raw_1", ["bank_statement_upload_v1"]]);
  });

  it("returns false when only parser-null or no parsed rows exist", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ count: 0 }], rowCount: 1 })),
    } as unknown as TenantScopedClient;

    await expect(hasValidParsedForArtifact(client, "raw_1")).resolves.toBe(false);
  });
});

describe("insertParsed", () => {
  it("repairs a single stale parsed row and clears its projection log", async () => {
    const log: { sql: string; values: unknown[] }[] = [];
    const staleRow = {
      id: "prs_1",
      raw_artifact_id: "raw_1",
      tenant_id: "ten_1",
      parser: "doc_obligation_v1",
      parser_version: "1.0.0",
      extracted: { kind: "doc_obligation" },
      confidence: 0.7,
      extracted_at: new Date("2026-06-01T00:00:00Z"),
    };
    const repairedRow = {
      ...staleRow,
      parser: "bank_statement_upload_v1",
      extracted: { object_type: "bank_statement", transactions: [] },
      confidence: 0.94,
    };
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        if (sql.includes("WHERE raw_artifact_id = $1 AND parser = $2")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("parser IS DISTINCT FROM")) {
          return { rows: [staleRow], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE raw_parsed")) {
          return { rows: [repairedRow], rowCount: 1 };
        }
        if (sql.startsWith("DELETE FROM canonical_projection_log")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as TenantScopedClient;

    const result = await insertParsed(client, {
      id: "prs_new",
      rawArtifactId: "raw_1",
      tenantId: "ten_1",
      parser: "bank_statement_upload_v1",
      parserVersion: "1.0.0",
      extracted: { object_type: "bank_statement", transactions: [] },
      confidence: 0.94,
    });

    expect(result.created).toBe(false);
    expect(result.row).toEqual(repairedRow);
    expect(log.some((entry) => entry.sql.startsWith("UPDATE raw_parsed"))).toBe(true);
    expect(log.some((entry) => entry.sql.startsWith("DELETE FROM canonical_projection_log"))).toBe(
      true,
    );
  });

  it("refreshes an exact parsed row only when a terminal zero-row projection log exists", async () => {
    const log: { sql: string; values: unknown[] }[] = [];
    const exactRow = {
      id: "prs_1",
      raw_artifact_id: "raw_1",
      tenant_id: "ten_1",
      parser: "bank_statement_upload_v1",
      parser_version: "1.0.0",
      extracted: { kind: "doc_obligation" },
      confidence: 0.7,
      extracted_at: new Date("2026-06-01T00:00:00Z"),
    };
    const repairedRow = {
      ...exactRow,
      extracted: { object_type: "bank_statement", transactions: [] },
      confidence: 0.94,
    };
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        if (sql.includes("WHERE raw_artifact_id = $1 AND parser = $2")) {
          return { rows: [exactRow], rowCount: 1 };
        }
        if (sql.includes("SELECT EXISTS")) {
          return { rows: [{ exists: true }], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE raw_parsed")) {
          return { rows: [repairedRow], rowCount: 1 };
        }
        if (sql.startsWith("DELETE FROM canonical_projection_log")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as TenantScopedClient;

    const result = await insertParsed(client, {
      id: "prs_new",
      rawArtifactId: "raw_1",
      tenantId: "ten_1",
      parser: "bank_statement_upload_v1",
      parserVersion: "1.0.0",
      extracted: { object_type: "bank_statement", transactions: [] },
      confidence: 0.94,
    });

    expect(result.created).toBe(false);
    expect(result.row).toEqual(repairedRow);
    expect(log.some((entry) => entry.sql.startsWith("INSERT INTO raw_parsed"))).toBe(false);
    expect(log.some((entry) => entry.sql.startsWith("DELETE FROM canonical_projection_log"))).toBe(
      true,
    );
  });
});
