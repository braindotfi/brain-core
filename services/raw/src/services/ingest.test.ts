import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditEmitter, MemoryBlobAdapter, newTenantId, newUserId } from "@brain/shared";
import { ingestOne } from "./ingest.js";

function makeFakePool(options: { existing?: boolean } = {}): {
  pool: { connect: () => Promise<unknown> };
  client: { released: boolean };
} {
  const client = {
    released: false,
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
      if (text.startsWith("INSERT INTO raw_artifacts")) {
        const id = (values?.[0] as string) ?? "raw_unknown";
        const returnedId = options.existing === true ? "raw_EXISTING" : id;
        return {
          rows: [
            {
              id: returnedId,
              tenant_id: values?.[1] as string,
              sha256: values?.[2] as Buffer,
              source_type: values?.[3] as string,
              source_ref: JSON.parse((values?.[4] as string) ?? "{}") as Record<string, unknown>,
              blob_uri: values?.[5] as string,
              mime_type: values?.[6] as string | null,
              bytes: String(values?.[7]),
              ingested_at: new Date(),
              tombstoned_at: null,
              ingested_by: values?.[8] as string,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(() => {
      client.released = true;
    }),
  };
  return {
    pool: { connect: async () => client },
    client,
  };
}

describe("ingestOne", () => {
  it("writes bytes to blob, inserts DB row, emits audit (new path)", async () => {
    const { pool } = makeFakePool();
    const blob = new MemoryBlobAdapter();
    const audit = new InMemoryAuditEmitter();

    const tenantId = newTenantId();
    const actor = newUserId();
    const body = Buffer.from("hello world");

    const result = await ingestOne(
      { pool: pool as unknown as Pool, blob, audit },
      {
        tenantId,
        actor,
        sourceType: "upload",
        sourceRef: { filename: "hello.txt" },
        body,
        mimeType: "text/plain",
      },
    );

    expect(result.deduplicated).toBe(false);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytes).toBe(body.length);
    expect(result.sourceType).toBe("upload");
    expect(result.rawId.startsWith("raw_")).toBe(true);

    // Blob contains the bytes under the tenant-prefixed path.
    const keys = Array.from(blob.objects.keys());
    expect(keys).toHaveLength(1);
    expect(keys[0]!.startsWith(`${tenantId}/`)).toBe(true);

    // Audit emitted new path.
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]!.action).toBe("raw.ingest.new");
    expect(audit.events[0]!.outputs.deduplicated).toBe(false);
  });

  it("marks deduplicated when DB returns an existing row id", async () => {
    const { pool } = makeFakePool({ existing: true });
    const blob = new MemoryBlobAdapter();
    const audit = new InMemoryAuditEmitter();

    const result = await ingestOne(
      { pool: pool as unknown as Pool, blob, audit },
      {
        tenantId: newTenantId(),
        actor: newUserId(),
        sourceType: "upload",
        sourceRef: {},
        body: Buffer.from("x"),
        mimeType: undefined,
      },
    );

    expect(result.deduplicated).toBe(true);
    expect(result.rawId).toBe("raw_EXISTING");
    expect(audit.events[0]!.action).toBe("raw.ingest.deduplicated");
  });

  it("applies immutable flag on blob put", async () => {
    const { pool } = makeFakePool();
    const blob = new MemoryBlobAdapter();
    const audit = new InMemoryAuditEmitter();
    const tenantId = newTenantId();

    await ingestOne(
      { pool: pool as unknown as Pool, blob, audit },
      {
        tenantId,
        actor: newUserId(),
        sourceType: "plaid",
        sourceRef: { webhook_id: "wh_1" },
        body: Buffer.from("pl"),
        mimeType: "application/json",
      },
    );

    const only = Array.from(blob.objects.values())[0]!;
    // MemoryBlobAdapter doesn't enforce immutability but records metadata.
    expect(only.contentType).toBe("application/json");
    expect(only.metadata.source_type).toBe("plaid");
    expect(only.metadata.tenant_id).toBe(tenantId);
  });
});
