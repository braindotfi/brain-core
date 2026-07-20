import { Readable } from "node:stream";
import Fastify, { type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  errorHandlerPlugin,
  newTenantExportJobId,
  newTenantId,
  type BlobAdapter,
  type Principal,
} from "@brain/shared";
import { registerTenantExportRoute } from "./route.js";
import type { TenantExportJobRow } from "./repository.js";

const TENANT_A = newTenantId();
const TENANT_B = newTenantId();
const USER = "usr_01TESTUSER000000000000000";
const AGENT = "agent_01TESTAGENT0000000000000";

function userPrincipal(tenantId: string): Principal {
  return {
    id: USER,
    type: "user",
    tenantId,
    scopes: [] as unknown as Principal["scopes"],
    tokenId: "tok_01TEST00000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function agentPrincipal(tenantId: string): Principal {
  return {
    id: AGENT,
    type: "agent",
    tenantId,
    scopes: [] as unknown as Principal["scopes"],
    tokenId: "tok_01TEST00000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function buildApp(opts: {
  principal: Principal | undefined;
  jobs?: TenantExportJobRow[];
  exportTtlMs?: number;
  omitExportTtlMs?: boolean;
}) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (opts.principal !== undefined) request.principal = opts.principal;
  });
  const state = new Map((opts.jobs ?? []).map((job) => [job.id, job]));
  const pool = fakePool(state);
  const blob: BlobAdapter = {
    put: vi.fn(),
    get: vi.fn(async () => Readable.from([Buffer.from("archive\n")])),
    signedUrl: vi.fn(),
    tombstone: vi.fn(),
    purgeTenant: vi.fn(),
    purgeObject: vi.fn(),
    healthcheck: vi.fn(),
  };
  await registerTenantExportRoute(app, {
    pool,
    blob,
    ...(opts.omitExportTtlMs === true ? {} : { exportTtlMs: opts.exportTtlMs ?? 86_400_000 }),
  });
  return { app, blob, pool, state };
}

describe("tenant export routes", () => {
  it("requires an authenticated user principal", async () => {
    const { app, pool } = await buildApp({ principal: undefined });
    try {
      const r = await app.inject({ method: "POST", url: `/tenants/${TENANT_A}/export` });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ error: { code: "auth_token_missing" } });
      const connect = pool.connect as unknown as ReturnType<typeof vi.fn>;
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("permits a tenant user to enqueue an export for their own tenant", async () => {
    const { app } = await buildApp({ principal: userPrincipal(TENANT_A) });
    try {
      const r = await app.inject({ method: "POST", url: `/tenants/${TENANT_A}/export` });
      expect(r.statusCode).toBe(202);
      expect(r.json()).toMatchObject({ tenant_id: TENANT_A, status: "queued" });
    } finally {
      await app.close();
    }
  });

  it("reuses an in-flight export job instead of stacking another one", async () => {
    const existing = jobRow({ status: "running" });
    const { app } = await buildApp({ principal: userPrincipal(TENANT_A), jobs: [existing] });
    try {
      const r = await app.inject({ method: "POST", url: `/tenants/${TENANT_A}/export` });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ job_id: existing.id, status: "running" });
    } finally {
      await app.close();
    }
  });

  it("uses the default export TTL when no override is supplied", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00Z"));
    const { app } = await buildApp({ principal: userPrincipal(TENANT_A), omitExportTtlMs: true });
    try {
      const r = await app.inject({ method: "POST", url: `/tenants/${TENANT_A}/export` });
      expect(r.statusCode).toBe(202);
      expect(r.json()).toMatchObject({ expires_at: "2026-07-27T00:00:00.000Z" });
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it("rejects cross-tenant and agent principals exactly like tenant deletion", async () => {
    const cross = await buildApp({ principal: userPrincipal(TENANT_A) });
    try {
      const r = await cross.app.inject({ method: "POST", url: `/tenants/${TENANT_B}/export` });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: { code: "auth_tenant_mismatch" } });
    } finally {
      await cross.app.close();
    }

    const agent = await buildApp({ principal: agentPrincipal(TENANT_A) });
    try {
      const r = await agent.app.inject({ method: "POST", url: `/tenants/${TENANT_A}/export` });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: { code: "auth_scope_insufficient" } });
    } finally {
      await agent.app.close();
    }
  });

  it("returns status and streams a non-expired completed archive", async () => {
    const job = jobRow({ status: "succeeded", outputBlobUri: `${TENANT_A}/exports/x.ndjson` });
    const { app, blob } = await buildApp({ principal: userPrincipal(TENANT_A), jobs: [job] });
    try {
      const status = await app.inject({
        method: "GET",
        url: `/tenants/${TENANT_A}/export/${job.id}`,
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ job_id: job.id, status: "succeeded", byte_size: 8 });

      const download = await app.inject({
        method: "GET",
        url: `/tenants/${TENANT_A}/export/${job.id}/download`,
      });
      expect(download.statusCode).toBe(200);
      expect(download.body).toBe("archive\n");
      expect(blob.get).toHaveBeenCalledWith(`${TENANT_A}/exports/x.ndjson`);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed export job ids before querying", async () => {
    const { app, pool } = await buildApp({ principal: userPrincipal(TENANT_A) });
    try {
      const r = await app.inject({ method: "GET", url: `/tenants/${TENANT_A}/export/not-a-job` });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: { code: "request_params_invalid" } });
      const connect = pool.connect as unknown as ReturnType<typeof vi.fn>;
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when a well-formed export job is not visible", async () => {
    const missingId = newTenantExportJobId();
    const { app } = await buildApp({ principal: userPrincipal(TENANT_A) });
    try {
      const r = await app.inject({
        method: "GET",
        url: `/tenants/${TENANT_A}/export/${missingId}`,
      });
      expect(r.statusCode).toBe(404);
      expect(r.json()).toMatchObject({ error: { code: "tenant_export_job_not_found" } });
    } finally {
      await app.close();
    }
  });

  it("returns 410 for an expired completed archive", async () => {
    const job = jobRow({
      status: "succeeded",
      outputBlobUri: `${TENANT_A}/exports/x.ndjson`,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    });
    const { app } = await buildApp({ principal: userPrincipal(TENANT_A), jobs: [job] });
    try {
      const r = await app.inject({
        method: "GET",
        url: `/tenants/${TENANT_A}/export/${job.id}/download`,
      });
      expect(r.statusCode).toBe(410);
    } finally {
      await app.close();
    }
  });

  it("keeps returning 410 after an expired archive has been purged", async () => {
    const job = jobRow({
      status: "succeeded",
      outputBlobUri: null,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
    });
    job.purged_at = new Date("2020-01-08T00:00:00Z");
    const { app } = await buildApp({ principal: userPrincipal(TENANT_A), jobs: [job] });
    try {
      const r = await app.inject({
        method: "GET",
        url: `/tenants/${TENANT_A}/export/${job.id}/download`,
      });
      expect(r.statusCode).toBe(410);
    } finally {
      await app.close();
    }
  });
});

function fakePool(state: Map<string, TenantExportJobRow>): Pool {
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
      if (sql.startsWith("INSERT INTO tenant_export_jobs")) {
        const existing = [...state.values()].find((job) =>
          ["queued", "running"].includes(job.status),
        );
        if (existing !== undefined) return { rows: [existing], rowCount: 1 };
        const row = jobRow({
          id: String(values?.[0]),
          tenantId: String(values?.[1]),
          requestedBy: String(values?.[2]),
          expiresAt: values?.[3] as Date,
        });
        state.set(row.id, row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("FROM tenant_export_jobs") && sql.includes("WHERE id = $1")) {
        const row = state.get(String(values?.[0]));
        return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function jobRow(input: {
  id?: string;
  tenantId?: string;
  status?: TenantExportJobRow["status"];
  outputBlobUri?: string | null;
  requestedBy?: string;
  expiresAt?: Date;
}): TenantExportJobRow {
  const now = new Date("2026-07-20T00:00:00Z");
  return {
    id: input.id ?? newTenantExportJobId(),
    tenant_id: input.tenantId ?? TENANT_A,
    status: input.status ?? "queued",
    output_blob_uri: input.outputBlobUri ?? null,
    byte_size: input.outputBlobUri === undefined ? null : 8,
    expires_at: input.expiresAt ?? new Date("2026-07-27T00:00:00Z"),
    error: null,
    requested_by: input.requestedBy ?? USER,
    locked_at: null,
    locked_by: null,
    started_at: null,
    finished_at: null,
    purged_at: null,
    created_at: now,
    updated_at: now,
  };
}
