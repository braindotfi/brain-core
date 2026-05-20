import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import { listParsedByArtifact } from "./parsed.js";

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
