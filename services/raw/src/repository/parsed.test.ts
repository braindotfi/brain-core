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

  it("can require a current parser version", async () => {
    const log: { sql: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        return { rows: [{ count: "0" }], rowCount: 1 };
      }),
    } as unknown as TenantScopedClient;

    await expect(
      hasValidParsedForArtifact(client, "raw_1", {
        acceptedParsers: ["bank_statement_upload_v1"],
        acceptedParserVersions: ["1.0.1"],
      }),
    ).resolves.toBe(false);
    expect(log[0]!.sql).toContain("rp.parser = ANY($2::text[])");
    expect(log[0]!.sql).toContain("rp.parser_version = ANY($3::text[])");
    expect(log[0]!.values).toEqual(["raw_1", ["bank_statement_upload_v1"], ["1.0.1"]]);
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
      allowRepair: true, // trusted extraction worker, not the HTTP route
    });

    expect(result.created).toBe(false);
    expect(result.row).toEqual(repairedRow);
    expect(log.some((entry) => entry.sql.startsWith("UPDATE raw_parsed"))).toBe(true);
    // The projection log row is no longer deleted: worker.ts's version-gated
    // pending predicate now re-projects on the bumped extracted_at instead.
    expect(log.some((entry) => entry.sql.startsWith("DELETE FROM canonical_projection_log"))).toBe(
      false,
    );
  });

  it("refreshes an exact upload parsed row when its payload shape is stale", async () => {
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
        if (sql.startsWith("UPDATE raw_parsed")) {
          return { rows: [repairedRow], rowCount: 1 };
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
      allowRepair: true, // trusted extraction worker, not the HTTP route
    });

    expect(result.created).toBe(false);
    expect(result.row).toEqual(repairedRow);
    expect(log.some((entry) => entry.sql.startsWith("INSERT INTO raw_parsed"))).toBe(false);
    expect(log.some((entry) => entry.sql.includes("SELECT EXISTS"))).toBe(false);
    // The projection log row is no longer deleted: worker.ts's version-gated
    // pending predicate now re-projects on the bumped extracted_at instead.
    expect(log.some((entry) => entry.sql.startsWith("DELETE FROM canonical_projection_log"))).toBe(
      false,
    );
  });

  it("keeps an exact valid upload parsed row when no terminal zero-row projection log exists", async () => {
    const log: { sql: string; values: unknown[] }[] = [];
    const exactRow = {
      id: "prs_1",
      raw_artifact_id: "raw_1",
      tenant_id: "ten_1",
      parser: "bank_statement_upload_v1",
      parser_version: "1.0.0",
      extracted: { object_type: "bank_statement", transactions: [] },
      confidence: 0.94,
      extracted_at: new Date("2026-06-01T00:00:00Z"),
    };
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        if (sql.includes("WHERE raw_artifact_id = $1 AND parser = $2")) {
          return { rows: [exactRow], rowCount: 1 };
        }
        if (sql.includes("SELECT EXISTS")) {
          return { rows: [{ exists: false }], rowCount: 1 };
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
    expect(result.row).toEqual(exactRow);
    expect(log.some((entry) => entry.sql.startsWith("UPDATE raw_parsed"))).toBe(false);
  });

  it("repairs an exact upload parsed row whose correct-shaped content changed", async () => {
    const log: { sql: string; values: unknown[] }[] = [];
    const exactRow = {
      id: "prs_1",
      raw_artifact_id: "raw_1",
      tenant_id: "ten_1",
      parser: "bank_statement_upload_v1",
      parser_version: "1.0.0",
      extracted: { object_type: "bank_statement", transactions: [{ id: "tx_1" }] },
      confidence: 0.6,
      extracted_at: new Date("2026-06-01T00:00:00Z"),
    };
    const repairedRow = {
      ...exactRow,
      extracted: {
        object_type: "bank_statement",
        transactions: Array.from({ length: 40 }, (_, i) => ({ id: `tx_${i}` })),
      },
      confidence: 0.94,
    };
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        if (sql.includes("WHERE raw_artifact_id = $1 AND parser = $2")) {
          return { rows: [exactRow], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE raw_parsed")) {
          return { rows: [repairedRow], rowCount: 1 };
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
      extracted: {
        object_type: "bank_statement",
        transactions: Array.from({ length: 40 }, (_, i) => ({ id: `tx_${i}` })),
      },
      confidence: 0.94,
      allowRepair: true, // trusted extraction worker, not the HTTP route
    });

    expect(result.created).toBe(false);
    expect(result.row).toEqual(repairedRow);
    expect(log.some((entry) => entry.sql.startsWith("UPDATE raw_parsed"))).toBe(true);
    // Content differs (3 -> 40 transactions) even though the shape is already
    // valid, so the repair fires without needing the zero-row-log probe.
    expect(log.some((entry) => entry.sql.includes("SELECT EXISTS"))).toBe(false);
  });

  it("H4: the route call shape (no allowRepair) cannot mutate an existing row on content diff", async () => {
    const log: { sql: string; values: unknown[] }[] = [];
    const exactRow = {
      id: "prs_1",
      raw_artifact_id: "raw_1",
      tenant_id: "ten_1",
      parser: "bank_statement_upload_v1",
      parser_version: "1.0.0",
      extracted: { object_type: "bank_statement", transactions: [{ id: "tx_1" }] },
      confidence: 0.6,
      extracted_at: new Date("2026-06-01T00:00:00Z"),
    };
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        if (sql.includes("WHERE raw_artifact_id = $1 AND parser = $2")) {
          return { rows: [exactRow], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as TenantScopedClient;

    // Same input as the "correct-shaped content changed" repair test above,
    // MINUS allowRepair -- exactly what services/raw/src/routes/parsed.ts's
    // POST handler passes.
    const result = await insertParsed(client, {
      id: "prs_new",
      rawArtifactId: "raw_1",
      tenantId: "ten_1",
      parser: "bank_statement_upload_v1",
      parserVersion: "1.0.0",
      extracted: {
        object_type: "bank_statement",
        transactions: Array.from({ length: 40 }, (_, i) => ({ id: `tx_${i}` })),
      },
      confidence: 0.94,
    });

    expect(result.created).toBe(false);
    expect(result.row).toEqual(exactRow); // unchanged -- not overwritten to 40
    expect(log.some((entry) => entry.sql.startsWith("UPDATE raw_parsed"))).toBe(false);
    expect(log.some((entry) => entry.sql.includes("SELECT EXISTS"))).toBe(false);
  });

  it("M2: the content-diff check does not throw when extracted carries an undefined field, and still detects a real change", async () => {
    // A reachable production shape: services/raw/src/interpreters/upload.ts's
    // AR-aging rows could carry `amount: undefined` before its own fix. The
    // shared stableStringify (shared/src/audit/hash.ts) throws a TypeError on
    // undefined; extractedPayloadChanged must normalize it away first --
    // without losing the ability to detect an actual content change sitting
    // alongside the undefined field (2 transactions -> 1, one of them
    // carrying `amount: undefined`).
    const log: { sql: string; values: unknown[] }[] = [];
    const exactRow = {
      id: "prs_1",
      raw_artifact_id: "raw_1",
      tenant_id: "ten_1",
      parser: "bank_statement_upload_v1",
      parser_version: "1.0.0",
      extracted: {
        object_type: "bank_statement",
        transactions: [{ id: "tx_1" }, { id: "tx_2" }],
      },
      confidence: 0.6,
      extracted_at: new Date("2026-06-01T00:00:00Z"),
    };
    const repairedRow = {
      ...exactRow,
      extracted: {
        object_type: "bank_statement",
        transactions: [{ id: "tx_1", amount: undefined }],
      },
      confidence: 0.94,
    };
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        if (sql.includes("WHERE raw_artifact_id = $1 AND parser = $2")) {
          return { rows: [exactRow], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE raw_parsed")) {
          return { rows: [repairedRow], rowCount: 1 };
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
      extracted: {
        object_type: "bank_statement",
        transactions: [{ id: "tx_1", amount: undefined }],
      },
      confidence: 0.94,
      allowRepair: true,
    });

    expect(result.row).toEqual(repairedRow); // did not throw, and detected the real diff
    expect(log.some((entry) => entry.sql.startsWith("UPDATE raw_parsed"))).toBe(true);
  });
});
