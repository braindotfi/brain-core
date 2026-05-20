import { describe, expect, it, vi } from "vitest";
import { findArtifactById, insertOrReuseArtifact, tombstoneArtifact } from "./artifacts.js";

function fakeClient(rows: unknown[] = []) {
  const log: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
      log.push({ sql, values: Array.from(values ?? []) });
      return { rows: [...rows], rowCount: rows.length };
    }),
  };
  return { client, log };
}

const stubRow = {
  id: "raw_1",
  tenant_id: "t1",
  sha256: Buffer.from("aa", "hex"),
  source_type: "plaid",
  source_ref: {},
  blob_uri: "az://b/f",
  mime_type: null,
  bytes: "1024",
  ingested_at: new Date(),
  tombstoned_at: null,
  ingested_by: "agent_1",
};

describe("insertOrReuseArtifact", () => {
  it("inserts and returns the row with deduplicated=false when id matches", async () => {
    const { client } = fakeClient([stubRow]);
    const result = await insertOrReuseArtifact(client, {
      id: "raw_1",
      tenantId: "t1",
      sha256Hex: "aa",
      sourceType: "plaid",
      sourceRef: {},
      blobUri: "az://b/f",
      mimeType: undefined,
      bytes: 1024,
      ingestedBy: "agent_1",
    });
    expect(result.deduplicated).toBe(false);
    expect(result.row).toBe(stubRow);
  });

  it("sets deduplicated=true when returned id differs from requested id", async () => {
    const conflictRow = { ...stubRow, id: "raw_existing" };
    const { client } = fakeClient([conflictRow]);
    const result = await insertOrReuseArtifact(client, {
      id: "raw_new",
      tenantId: "t1",
      sha256Hex: "aa",
      sourceType: "plaid",
      sourceRef: {},
      blobUri: "az://b/f",
      mimeType: "text/plain",
      bytes: 512,
      ingestedBy: "agent_1",
    });
    expect(result.deduplicated).toBe(true);
  });

  it("throws when insert returns no row", async () => {
    const { client } = fakeClient([]);
    await expect(
      insertOrReuseArtifact(client, {
        id: "raw_x",
        tenantId: "t1",
        sha256Hex: "bb",
        sourceType: "plaid",
        sourceRef: {},
        blobUri: "az://b/g",
        mimeType: undefined,
        bytes: 0,
        ingestedBy: "agent_1",
      }),
    ).rejects.toThrow("raw_artifacts insert returned no row");
  });
});

describe("findArtifactById", () => {
  it("returns null when not found", async () => {
    const { client, log } = fakeClient([]);
    const result = await findArtifactById(client, "raw_missing");
    expect(result).toBeNull();
    expect(log[0]!.sql).toContain("WHERE id = $1");
    expect(log[0]!.values).toEqual(["raw_missing"]);
  });

  it("returns the row when found", async () => {
    const { client } = fakeClient([stubRow]);
    const result = await findArtifactById(client, "raw_1");
    expect(result).toBe(stubRow);
  });
});

describe("tombstoneArtifact", () => {
  it("returns notFound=true when artifact does not exist", async () => {
    const { client } = fakeClient([]);
    const result = await tombstoneArtifact(client, "raw_missing");
    expect(result).toEqual({ alreadyTombstoned: false, notFound: true });
  });

  it("returns alreadyTombstoned=true when tombstoned_at is set", async () => {
    const tombstoned = { ...stubRow, tombstoned_at: new Date("2024-01-01") };
    const { client } = fakeClient([tombstoned]);
    const result = await tombstoneArtifact(client, "raw_1");
    expect(result).toEqual({ alreadyTombstoned: true, notFound: false });
  });

  it("issues UPDATE and returns success for a live artifact", async () => {
    const log: { sql: string; values: unknown[] }[] = [];
    let call = 0;
    const client = {
      query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
        log.push({ sql, values: Array.from(values ?? []) });
        // First call is findArtifactById, second is the UPDATE
        return { rows: call++ === 0 ? [stubRow] : [], rowCount: 1 };
      }),
    };
    const at = new Date("2024-06-01");
    const result = await tombstoneArtifact(client, "raw_1", at);
    expect(result).toEqual({ alreadyTombstoned: false, notFound: false });
    expect(log[1]!.sql).toContain("SET tombstoned_at = $1");
    expect(log[1]!.values).toEqual([at, "raw_1"]);
  });
});
