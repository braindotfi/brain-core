import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newRawExtractionJobId,
  newRawArtifactId,
  newTenantId,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { Pool } from "pg";
import { registerRawExtractRoute } from "./route.js";

const TENANT = newTenantId();
const RAW_ID = newRawArtifactId();

function principal(scopes: readonly Scope[] = ["raw:write"]): Principal {
  return {
    id: "user_01TEST0000000000000000000",
    type: "user",
    tenantId: TENANT,
    scopes,
    tokenId: "token_01TEST00000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function artifactRow(id = RAW_ID) {
  return {
    id,
    tenant_id: TENANT,
    sha256: Buffer.from("00".repeat(32), "hex"),
    source_type: "pdf_upload",
    source_ref: {},
    blob_uri: `${TENANT}/2026/07/06/artifact.pdf`,
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

function jobRow(
  rawId = RAW_ID,
  status: "queued" | "running" | "succeeded" | "failed" = "queued",
): {
  id: string;
  tenant_id: string;
  raw_id: string;
  content_sha256: Buffer;
  status: "queued" | "running" | "succeeded" | "failed";
  parsed_id: string | null;
  confidence: number | null;
  error: Record<string, unknown> | null;
  attempt_count: number;
  next_attempt_at: Date | null;
  requested_by: string | null;
  locked_at: Date | null;
  locked_by: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
} {
  const now = new Date("2026-07-06T00:00:00Z");
  return {
    id: newRawExtractionJobId(),
    tenant_id: TENANT,
    raw_id: rawId,
    content_sha256: Buffer.from("00".repeat(32), "hex"),
    status,
    parsed_id: null,
    confidence: null,
    error: null,
    attempt_count: 0,
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

function fakePool(row: ReturnType<typeof artifactRow> | null, latestJob = jobRow()): Pool {
  const client = {
    query: vi.fn((sql: string) => {
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("FROM raw_artifacts")) {
        const rows = row === null ? [] : [row];
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (sql.includes("INSERT INTO extraction_jobs")) {
        return Promise.resolve({ rows: [latestJob], rowCount: 1 });
      }
      if (sql.includes("FROM extraction_jobs")) {
        return Promise.resolve({ rows: [latestJob], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
}

async function buildApp(opts: {
  principal: Principal | undefined;
  row?: ReturnType<typeof artifactRow> | null;
  latestJob?: ReturnType<typeof jobRow>;
}) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (opts.principal !== undefined) {
      request.principal = opts.principal;
    }
  });
  const pool = fakePool(opts.row === undefined ? artifactRow() : opts.row, opts.latestJob);
  await registerRawExtractRoute(app, {
    pool,
  });
  return { app, pool };
}

describe("POST /raw/:raw_id/extract", () => {
  it("requires raw:write scope", async () => {
    const { app, pool } = await buildApp({ principal: principal([]) });
    try {
      const res = await app.inject({ method: "POST", url: `/raw/${RAW_ID}/extract` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "auth_scope_insufficient" } });
      const connect = pool.connect as unknown as ReturnType<typeof vi.fn>;
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the artifact is not visible in the tenant scope", async () => {
    const { app } = await buildApp({ principal: principal(), row: null });
    try {
      const res = await app.inject({ method: "POST", url: `/raw/${RAW_ID}/extract` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: "raw_artifact_not_found" } });
    } finally {
      await app.close();
    }
  });

  it("enqueues an async extraction job without calling the extractor on the request path", async () => {
    const latestJob = jobRow();
    const { app } = await buildApp({ principal: principal(), latestJob });
    try {
      const res = await app.inject({ method: "POST", url: `/raw/${RAW_ID}/extract` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        job_id: latestJob.id,
        raw_id: RAW_ID,
        status: "queued",
        parsed_id: null,
        confidence: null,
        error: null,
        next_attempt_at: null,
        created_at: "2026-07-06T00:00:00.000Z",
        updated_at: "2026-07-06T00:00:00.000Z",
      });
    } finally {
      await app.close();
    }
  });

  it("returns the latest extraction status", async () => {
    const latestJob = {
      ...jobRow(),
      status: "succeeded" as const,
      parsed_id: "prs_01TEST000000000000000000000",
      confidence: 0.5,
    };
    const { app } = await buildApp({ principal: principal(["raw:read"]), latestJob });
    try {
      const res = await app.inject({ method: "GET", url: `/raw/${RAW_ID}/extraction` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        job_id: latestJob.id,
        raw_id: RAW_ID,
        status: "succeeded",
        parsed_id: "prs_01TEST000000000000000000000",
        confidence: 0.5,
        error: null,
        next_attempt_at: null,
        created_at: "2026-07-06T00:00:00.000Z",
        updated_at: "2026-07-06T00:00:00.000Z",
      });
    } finally {
      await app.close();
    }
  });

  it("requires raw:read scope for extraction status", async () => {
    const { app } = await buildApp({ principal: principal(["raw:write"]) });
    try {
      const res = await app.inject({ method: "GET", url: `/raw/${RAW_ID}/extraction` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "auth_scope_insufficient" } });
    } finally {
      await app.close();
    }
  });
});
