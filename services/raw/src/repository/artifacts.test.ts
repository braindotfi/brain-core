import { describe, expect, it, vi } from "vitest";
import type { TenantScopedClient } from "@brain/shared";
import {
  findArtifactById,
  insertOrReuseArtifact,
  tombstoneArtifact,
  type RawArtifactRow,
} from "./artifacts.js";

function fakeClient(rows: unknown[] = []): {
  client: TenantScopedClient;
  log: { sql: string; values: unknown[] }[];
} {
  const log: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
      log.push({ sql, values: Array.from(values ?? []) });
      return { rows: [...rows], rowCount: rows.length };
    }),
  };
  return { client: client as unknown as TenantScopedClient, log };
}

const stubRow: RawArtifactRow = {
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
  source_schema: null,
  object_type: null,
  external_id: null,
  operation: null,
  effective_at: null,
  observed_at: null,
  original_source: null,
  intermediaries: null,
  source_id: null,
  source_version: null,
  idempotency_key: null,
};

function statefulDedupClient(initialRows: RawArtifactRow[] = []): {
  client: TenantScopedClient;
  rows: Map<string, RawArtifactRow>;
  log: { sql: string; values: unknown[] }[];
} {
  const rows = new Map(initialRows.map((row) => [row.sha256.toString("hex"), { ...row }]));
  const log: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: ReadonlyArray<unknown>) => {
      log.push({ sql, values: Array.from(values ?? []) });
      if (!sql.startsWith("INSERT INTO raw_artifacts")) return { rows: [], rowCount: 0 };
      const sha = values?.[2] as Buffer;
      const key = sha.toString("hex");
      const incomingSchema = (values?.[9] as string | null) ?? null;
      const existing = rows.get(key);
      if (existing !== undefined) {
        existing.source_schema = existing.source_schema ?? incomingSchema;
        return { rows: [existing], rowCount: 1 };
      }
      const row = {
        ...stubRow,
        id: values?.[0] as string,
        tenant_id: values?.[1] as string,
        sha256: sha,
        source_type: values?.[3] as string,
        source_ref: JSON.parse((values?.[4] as string) ?? "{}") as Record<string, unknown>,
        blob_uri: values?.[5] as string,
        mime_type: (values?.[6] as string | null) ?? null,
        bytes: String(values?.[7]),
        ingested_by: values?.[8] as string,
        source_schema: incomingSchema,
      };
      rows.set(key, row);
      return { rows: [row], rowCount: 1 };
    }),
  };
  return { client: client as unknown as TenantScopedClient, rows, log };
}

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

  it("fills a missing source_schema when identical bytes are reingested with schema metadata", async () => {
    const { client, log } = statefulDedupClient();
    const first = await insertOrReuseArtifact(client, {
      id: "raw_old",
      tenantId: "t1",
      sha256Hex: "aa",
      sourceType: "csv_upload",
      sourceRef: {},
      blobUri: "az://b/upload",
      mimeType: "text/csv",
      bytes: 128,
      ingestedBy: "agent_1",
    });
    const firstSchema = first.row.source_schema;
    const second = await insertOrReuseArtifact(client, {
      id: "raw_new",
      tenantId: "t1",
      sha256Hex: "aa",
      sourceType: "csv_upload",
      sourceRef: {},
      blobUri: "az://b/upload",
      mimeType: "text/csv",
      bytes: 128,
      ingestedBy: "agent_1",
      envelope: { sourceSchema: "brain.upload.document.v1" },
    });

    expect(firstSchema).toBeNull();
    expect(second.deduplicated).toBe(true);
    expect(second.row.id).toBe("raw_old");
    expect(second.row.source_schema).toBe("brain.upload.document.v1");
    expect(log[0]!.sql).toContain(
      "source_schema = COALESCE(raw_artifacts.source_schema, EXCLUDED.source_schema)",
    );
  });

  it("does not replace an existing source_schema when identical bytes are reingested differently", async () => {
    const existing = {
      ...stubRow,
      id: "raw_existing",
      sha256: Buffer.from("bb", "hex"),
      source_schema: "brain.upload.document.v1",
    };
    const { client } = statefulDedupClient([existing]);
    const result = await insertOrReuseArtifact(client, {
      id: "raw_new",
      tenantId: "t1",
      sha256Hex: "bb",
      sourceType: "csv_upload",
      sourceRef: {},
      blobUri: "az://b/upload",
      mimeType: "text/csv",
      bytes: 128,
      ingestedBy: "agent_1",
      envelope: { sourceSchema: "different.schema.v1" },
    });

    expect(result.deduplicated).toBe(true);
    expect(result.row.id).toBe("raw_existing");
    expect(result.row.source_schema).toBe("brain.upload.document.v1");
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
    } as unknown as TenantScopedClient;
    const at = new Date("2024-06-01");
    const result = await tombstoneArtifact(client, "raw_1", at);
    expect(result).toEqual({ alreadyTombstoned: false, notFound: false });
    expect(log[1]!.sql).toContain("SET tombstoned_at = $1");
    expect(log[1]!.values).toEqual([at, "raw_1"]);
  });
});
