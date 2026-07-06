import { Readable } from "node:stream";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newRawArtifactId,
  newTenantId,
  type Principal,
  type Scope,
} from "@brain/shared";
import type { BlobAdapter } from "@brain/shared";
import type { Pool } from "pg";
import { registerRawExtractRoute, type DocumentExtractPort } from "./route.js";

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

function fakePool(row: ReturnType<typeof artifactRow> | null): Pool {
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
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool;
}

function fakeBlob(bytes = Buffer.from("invoice")): BlobAdapter {
  return {
    put: vi.fn(),
    get: vi.fn(async () => Readable.from([bytes])),
    signedUrl: vi.fn(),
    tombstone: vi.fn(),
    purgeTenant: vi.fn(),
    healthcheck: vi.fn(),
  } as unknown as BlobAdapter;
}

async function buildApp(opts: {
  principal: Principal | undefined;
  row?: ReturnType<typeof artifactRow> | null;
  client?: DocumentExtractPort;
}) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (opts.principal !== undefined) {
      request.principal = opts.principal;
    }
  });
  const extractClient =
    opts.client ??
    ({
      extract: vi.fn(async () => ({
        parsed_id: "prs_01TEST000000000000000000000",
        confidence: 0.8,
      })),
    } satisfies DocumentExtractPort);
  const pool = fakePool(opts.row === undefined ? artifactRow() : opts.row);
  const blob = fakeBlob();
  await registerRawExtractRoute(app, {
    pool,
    blob,
    client: extractClient,
    agentId: "document_extractor",
  });
  return { app, extractClient };
}

describe("POST /raw/:raw_id/extract", () => {
  it("requires raw:write scope", async () => {
    const { app, extractClient } = await buildApp({ principal: principal([]) });
    try {
      const res = await app.inject({ method: "POST", url: `/raw/${RAW_ID}/extract` });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "auth_scope_insufficient" } });
      expect(extractClient.extract).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the artifact is not visible in the tenant scope", async () => {
    const { app, extractClient } = await buildApp({ principal: principal(), row: null });
    try {
      const res = await app.inject({ method: "POST", url: `/raw/${RAW_ID}/extract` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: "raw_artifact_not_found" } });
      expect(extractClient.extract).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 501 when no document extraction client is configured", async () => {
    const app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.addHook("preHandler", async (request: FastifyRequest) => {
      request.principal = principal();
    });
    await registerRawExtractRoute(app, {
      pool: fakePool(artifactRow()),
      blob: fakeBlob(),
      agentId: "document_extractor",
    });
    try {
      const res = await app.inject({ method: "POST", url: `/raw/${RAW_ID}/extract` });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({ error: { code: "dependency_unavailable" } });
    } finally {
      await app.close();
    }
  });

  it("base64 encodes the artifact and returns the extractor result", async () => {
    const client: DocumentExtractPort = {
      extract: vi.fn(async () => ({
        parsed_id: "prs_01TEST000000000000000000000",
        confidence: 0.97,
      })),
    };
    const { app } = await buildApp({ principal: principal(), client });
    try {
      const res = await app.inject({ method: "POST", url: `/raw/${RAW_ID}/extract` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        parsed_id: "prs_01TEST000000000000000000000",
        confidence: 0.97,
      });
      expect(client.extract).toHaveBeenCalledWith(
        {
          tenantId: TENANT,
          actor: "user_01TEST0000000000000000000",
          principalType: "user",
          scopes: ["raw:write"],
        },
        {
          rawId: RAW_ID,
          mimeType: "application/pdf",
          documentB64: Buffer.from("invoice").toString("base64"),
          agentId: "document_extractor",
        },
      );
    } finally {
      await app.close();
    }
  });
});
