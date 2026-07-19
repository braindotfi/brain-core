import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  MemoryBlobAdapter,
  newRawExtractionJobId,
  newTenantId,
  newUserId,
} from "@brain/shared";
import { ingestOne } from "./ingest.js";

function makeFakePool(
  options: { existing?: boolean; idempotencyHit?: boolean; autoExtract?: boolean } = {},
): {
  pool: { connect: () => Promise<unknown> };
  client: { released: boolean; inserts: unknown[][]; jobs: unknown[][] };
} {
  const client = {
    released: false,
    inserts: [] as unknown[][],
    jobs: [] as unknown[][],
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT set_config")) return { rows: [], rowCount: 0 };
      if (text.includes("WHERE idempotency_key")) {
        if (options.idempotencyHit === true) {
          return {
            rows: [
              {
                id: "raw_IDEM_EXISTING",
                bytes: "1",
                source_type: "other",
                source_schema: "acme.v1",
                ingested_at: new Date(),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM raw_tenant_settings")) {
        return {
          rows: options.autoExtract === true ? [{ auto_extract_documents: true }] : [],
          rowCount: options.autoExtract === true ? 1 : 0,
        };
      }
      if (text.startsWith("INSERT INTO raw_artifacts")) {
        client.inserts.push(values ?? []);
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
              source_schema: (values?.[9] as string | null) ?? null,
              object_type: (values?.[10] as string | null) ?? null,
              external_id: (values?.[11] as string | null) ?? null,
              operation: (values?.[12] as string | null) ?? null,
              effective_at: null,
              observed_at: null,
              original_source: (values?.[15] as string | null) ?? null,
              intermediaries: null,
              source_id: (values?.[17] as string | null) ?? null,
              source_version: (values?.[18] as string | null) ?? null,
              idempotency_key: (values?.[19] as string | null) ?? null,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.startsWith("INSERT INTO extraction_jobs")) {
        client.jobs.push(values ?? []);
        const now = new Date("2026-07-06T00:00:00Z");
        return {
          rows: [
            {
              id: values?.[0] ?? newRawExtractionJobId(),
              tenant_id: values?.[1],
              raw_id: values?.[2],
              content_sha256: values?.[3],
              status: "queued",
              parsed_id: null,
              confidence: null,
              error: null,
              attempt_count: 0,
              requested_by: values?.[4],
              locked_at: null,
              locked_by: null,
              started_at: null,
              finished_at: null,
              created_at: now,
              updated_at: now,
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
        sourceType: "other",
        sourceRef: { filename: "hello.txt" },
        body,
        mimeType: "text/plain",
      },
    );

    expect(result.deduplicated).toBe(false);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytes).toBe(body.length);
    expect(result.sourceType).toBe("other");
    expect(result.rawId.startsWith("raw_")).toBe(true);
    expect(result.extractionJob).toBeNull();

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
        sourceType: "other",
        sourceRef: {},
        body: Buffer.from("x"),
        mimeType: undefined,
      },
    );

    expect(result.deduplicated).toBe(true);
    expect(result.rawId).toBe("raw_EXISTING");
    expect(audit.events[0]!.action).toBe("raw.ingest.deduplicated");
  });

  it("persists the declared envelope verbatim, including a never-seen source_schema", async () => {
    // Phase 1 AC (Appendix B): an artifact with an unknown source_schema
    // ingests and persists successfully and waits for a parser; nothing
    // parses at intake.
    const { pool, client } = makeFakePool();
    const blob = new MemoryBlobAdapter();
    const audit = new InMemoryAuditEmitter();

    const result = await ingestOne(
      { pool: pool as unknown as Pool, blob, audit },
      {
        tenantId: newTenantId(),
        actor: newUserId(),
        sourceType: "other",
        sourceRef: { export: "warehouse" },
        body: Buffer.from("col_a,col_b\n1,2"),
        mimeType: "text/csv",
        envelope: {
          sourceSchema: "acme_neobank.warehouse_tx.v1",
          objectType: "transaction",
          externalId: "tx_991",
          operation: "upsert",
          effectiveAt: "2026-05-31T00:00:00Z",
          observedAt: "2026-06-07T08:00:00Z",
          originalSource: "acme_neobank",
          intermediaries: ["customer_warehouse"],
          sourceVersion: "v3",
          idempotencyKey: "conn1:warehouse:tx_991:v3",
        },
      },
    );

    expect(result.deduplicated).toBe(false);
    expect(result.sourceSchema).toBe("acme_neobank.warehouse_tx.v1");

    const insert = client.inserts[0]!;
    expect(insert[9]).toBe("acme_neobank.warehouse_tx.v1"); // source_schema
    expect(insert[10]).toBe("transaction"); // object_type
    expect(insert[11]).toBe("tx_991"); // external_id
    expect(insert[12]).toBe("upsert"); // operation
    expect(insert[13]).toBe("2026-05-31T00:00:00Z"); // effective_at
    expect(insert[14]).toBe("2026-06-07T08:00:00Z"); // observed_at
    expect(insert[15]).toBe("acme_neobank"); // original_source
    expect(insert[16]).toBe(JSON.stringify(["customer_warehouse"])); // intermediaries
    expect(insert[18]).toBe("v3"); // source_version
    expect(insert[19]).toBe("conn1:warehouse:tx_991:v3"); // idempotency_key

    // Audit carries the declared schema (identifier, not payload).
    expect(audit.events[0]!.inputs.source_schema).toBe("acme_neobank.warehouse_tx.v1");
  });

  it("dedups by envelope idempotency_key before inserting", async () => {
    const { pool, client } = makeFakePool({ idempotencyHit: true });
    const blob = new MemoryBlobAdapter();
    const audit = new InMemoryAuditEmitter();

    const result = await ingestOne(
      { pool: pool as unknown as Pool, blob, audit },
      {
        tenantId: newTenantId(),
        actor: newUserId(),
        sourceType: "other",
        sourceRef: {},
        // Different bytes than the stored artifact — content-hash dedup would
        // miss, but the provider re-sent the same object version.
        body: Buffer.from("cosmetically different"),
        mimeType: undefined,
        envelope: { idempotencyKey: "conn1:warehouse:tx_991:v3" },
      },
    );

    expect(result.deduplicated).toBe(true);
    expect(result.rawId).toBe("raw_IDEM_EXISTING");
    expect(client.inserts).toHaveLength(0);
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

  it("auto-enqueues one document extraction job when tenant setting and agent config are on", async () => {
    const { pool, client } = makeFakePool({ autoExtract: true });
    const blob = new MemoryBlobAdapter();
    const audit = new InMemoryAuditEmitter();
    const tenantId = newTenantId();

    const result = await ingestOne(
      {
        pool: pool as unknown as Pool,
        blob,
        audit,
        extractionJobs: { documentExtractorConfigured: true },
      },
      {
        tenantId,
        actor: newUserId(),
        sourceType: "pdf_upload",
        sourceRef: { filename: "invoice.pdf" },
        body: Buffer.from("pdf"),
        mimeType: "application/pdf",
      },
    );

    expect(client.jobs).toHaveLength(1);
    expect(client.jobs[0]![1]).toBe(tenantId);
    expect(client.jobs[0]![2]).toBe(result.rawId);
    expect(result.extractionJob).toMatchObject({
      raw_id: result.rawId,
      status: "queued",
    });
  });

  it("does not auto-enqueue when the setting is on but the extractor is not configured", async () => {
    const { pool, client } = makeFakePool({ autoExtract: true });
    const blob = new MemoryBlobAdapter();
    const audit = new InMemoryAuditEmitter();

    const result = await ingestOne(
      {
        pool: pool as unknown as Pool,
        blob,
        audit,
        extractionJobs: { documentExtractorConfigured: false },
      },
      {
        tenantId: newTenantId(),
        actor: newUserId(),
        sourceType: "pdf_upload",
        sourceRef: { filename: "invoice.pdf" },
        body: Buffer.from("pdf"),
        mimeType: "application/pdf",
      },
    );

    expect(client.jobs).toHaveLength(0);
    expect(result.extractionJob).toBeNull();
  });
});
