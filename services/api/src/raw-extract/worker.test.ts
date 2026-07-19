import { Readable } from "node:stream";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryAuditEmitter,
  newRawArtifactId,
  newRawExtractionJobId,
  newTenantId,
  type BlobAdapter,
} from "@brain/shared";
import { runDocumentExtractionCycle, type DocumentExtractPort } from "./worker.js";

const TENANT = newTenantId();
const RAW_ID = newRawArtifactId();
const JOB_ID = newRawExtractionJobId();

function artifactRow() {
  return {
    id: RAW_ID,
    tenant_id: TENANT,
    sha256: Buffer.from("00".repeat(32), "hex"),
    source_type: "pdf_upload",
    source_ref: {},
    blob_uri: `${TENANT}/artifact.pdf`,
    mime_type: "application/pdf",
    bytes: "7",
    ingested_at: new Date("2026-07-06T00:00:00Z"),
    tombstoned_at: null,
    ingested_by: "user_01TEST0000000000000000000",
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
}

function jobRow(status = "queued", attemptCount = 0) {
  const now = new Date("2026-07-06T00:00:00Z");
  return {
    id: JOB_ID,
    tenant_id: TENANT,
    raw_id: RAW_ID,
    content_sha256: Buffer.from("00".repeat(32), "hex"),
    status,
    parsed_id: null,
    confidence: null,
    error: null,
    attempt_count: attemptCount,
    next_attempt_at: null,
    requested_by: "user_01TEST0000000000000000000",
    locked_at: null,
    locked_by: null,
    started_at: null,
    finished_at: null,
    created_at: now,
    updated_at: now,
  };
}

function scanPool(): Pool {
  return {
    query: vi.fn(async () => ({ rows: [{ id: JOB_ID, tenant_id: TENANT, raw_id: RAW_ID }] })),
  } as unknown as Pool;
}

function appPool(options: { claimedAttemptCount?: number } = {}) {
  const updates: Array<{ kind: string; values: unknown[] | undefined }> = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("UPDATE extraction_jobs") && sql.includes("status = 'running'")) {
        updates.push({ kind: "claim", values });
        return { rows: [jobRow("running", options.claimedAttemptCount ?? 1)], rowCount: 1 };
      }
      if (sql.includes("FROM raw_artifacts")) {
        return { rows: [artifactRow()], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE extraction_jobs") && sql.includes("status = 'succeeded'")) {
        updates.push({ kind: "succeeded", values });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE extraction_jobs") && sql.includes("status = 'queued'")) {
        updates.push({ kind: "retry", values });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE extraction_jobs") && sql.includes("status = 'failed'")) {
        updates.push({ kind: "failed", values });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
    updates,
  };
}

function blob(): BlobAdapter {
  return {
    put: vi.fn(),
    get: vi.fn(async () => Readable.from([Buffer.from("invoice")])),
    signedUrl: vi.fn(),
    tombstone: vi.fn(),
    purgeTenant: vi.fn(),
    healthcheck: vi.fn(),
  } as unknown as BlobAdapter;
}

describe("runDocumentExtractionCycle", () => {
  it("marks queued jobs failed when the extractor is not configured", async () => {
    const app = appPool();

    await runDocumentExtractionCycle(
      { scanPool: scanPool(), appPool: app.pool, blob: blob() },
      { batchSize: 1 },
    );

    const failed = app.updates.find((u) => u.kind === "failed");
    expect(failed).toBeDefined();
    expect(failed?.values?.[1]).toContain("dependency_unavailable");
  });

  it("calls the extractor from the worker and caps recorded confidence at 0.5", async () => {
    const app = appPool();
    const audit = new InMemoryAuditEmitter();
    const client: DocumentExtractPort = {
      extract: vi.fn(async () => ({
        parsed_id: "prs_01TEST000000000000000000000",
        confidence: 0.91,
      })),
    };

    await runDocumentExtractionCycle(
      { scanPool: scanPool(), appPool: app.pool, blob: blob(), client, audit },
      { batchSize: 1, agentId: "document_extractor" },
    );

    expect(client.extract).toHaveBeenCalledWith(
      {
        tenantId: TENANT,
        actor: "document_extraction_worker",
        principalType: "agent",
        scopes: ["raw:write"],
      },
      {
        rawId: RAW_ID,
        mimeType: "application/pdf",
        documentB64: Buffer.from("invoice").toString("base64"),
        agentId: "document_extractor",
      },
    );
    const succeeded = app.updates.find((u) => u.kind === "succeeded");
    expect(succeeded?.values).toEqual([JOB_ID, "prs_01TEST000000000000000000000", 0.5]);
    expect(audit.events.map((e) => e.action)).toEqual([
      "raw.extraction.status_changed",
      "raw.extraction.status_changed",
    ]);
    expect(audit.events[0]?.outputs).toMatchObject({
      before: { status: "queued" },
      after: { status: "running" },
    });
    expect(audit.events[1]?.outputs).toMatchObject({
      before: { status: "running" },
      after: { status: "succeeded", confidence: 0.5 },
    });
  });

  it("requeues transient extractor failures with bounded backoff", async () => {
    const app = appPool({ claimedAttemptCount: 1 });
    const client: DocumentExtractPort = {
      extract: vi.fn(async () => {
        throw new Error("timeout");
      }),
    };
    const now = new Date("2026-07-06T00:00:00Z");

    await runDocumentExtractionCycle(
      { scanPool: scanPool(), appPool: app.pool, blob: blob(), client },
      { batchSize: 1, maxAttempts: 3, retryBaseMs: 1_000, now: () => now },
    );

    const retry = app.updates.find((u) => u.kind === "retry");
    expect(retry?.values?.[0]).toBe(JOB_ID);
    expect(retry?.values?.[1]).toContain("internal_server_error");
    expect(retry?.values?.[2]).toEqual(new Date("2026-07-06T00:00:01Z"));
    expect(app.updates.some((u) => u.kind === "failed")).toBe(false);
  });

  it("marks transient failures terminal after the retry budget is exhausted", async () => {
    const app = appPool({ claimedAttemptCount: 3 });
    const client: DocumentExtractPort = {
      extract: vi.fn(async () => {
        throw new Error("timeout");
      }),
    };

    await runDocumentExtractionCycle(
      { scanPool: scanPool(), appPool: app.pool, blob: blob(), client },
      { batchSize: 1, maxAttempts: 3, retryBaseMs: 1_000 },
    );

    const failed = app.updates.find((u) => u.kind === "failed");
    expect(failed?.values?.[1]).toContain("retry_exhausted");
    expect(app.updates.some((u) => u.kind === "retry")).toBe(false);
  });
});
