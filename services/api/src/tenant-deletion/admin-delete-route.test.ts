import { describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
import {
  InMemoryApiSlidingWindowRateLimiter,
  errorHandlerPlugin,
  newApiPartnerId,
  newTenantDeletionJobId,
  newTenantId,
  type Principal,
} from "@brain/shared";
import { registerAdminTenantDeletionRoutes } from "./admin-delete-route.js";

const TENANT = newTenantId();
const CALLER = newApiPartnerId();
const JOB = newTenantDeletionJobId();

function principal(scopes: string[] = ["tenant:delete"]): Principal {
  return {
    id: CALLER,
    type: "api_partner",
    tenantId: TENANT,
    scopes: scopes as Principal["scopes"],
    tokenId: "token_01J00000000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

const row = {
  id: JOB,
  tenant_id: TENANT,
  requested_by: CALLER,
  status: "queued" as const,
  expected_rows: null,
  deleted_rows: null,
  total_rows_deleted: null,
  blob_purge_job_id: null,
  blob_artifact_count: null,
  last_error: null,
  created_at: new Date("2026-09-06T00:00:00Z"),
  started_at: null,
  completed_at: null,
};

async function build(
  opts: {
    apiKey?: boolean;
    authenticated?: boolean;
    scopes?: string[];
    rateLimiter?: { hit: ReturnType<typeof vi.fn> };
  } = {},
) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (opts.authenticated !== false) request.principal = principal(opts.scopes);
    if (opts.apiKey === true) request.apiKeyId = "akey_01J0000000000000000000000";
  });
  const service = {
    request: vi.fn(() => Promise.resolve({ created: true, row })),
    find: vi.fn<() => Promise<typeof row | null>>(() => Promise.resolve(row)),
  };
  await registerAdminTenantDeletionRoutes(app, {
    service: service as never,
    rateLimiter: (opts.rateLimiter ?? new InMemoryApiSlidingWindowRateLimiter()) as never,
  });
  return { app, service };
}

describe("admin tenant deletion routes", () => {
  it("accepts a dedicated api_partner credential and returns 202", async () => {
    const { app, service } = await build();
    try {
      const response = await app.inject({ method: "POST", url: `/admin/tenants/${TENANT}/delete` });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ job_id: JOB, tenant_id: TENANT, status: "queued" });
      expect(service.request).toHaveBeenCalledWith(TENANT, CALLER, expect.any(String));
    } finally {
      await app.close();
    }
  });

  it("rejects a normal tenant API key even if it asserts tenant:delete", async () => {
    const { app } = await build({ apiKey: true });
    try {
      const response = await app.inject({ method: "POST", url: `/admin/tenants/${TENANT}/delete` });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "auth_scope_insufficient" } });
    } finally {
      await app.close();
    }
  });

  it("returns the existing job status to its caller", async () => {
    const { app } = await build();
    try {
      const response = await app.inject({ method: "GET", url: `/admin/tenant-deletions/${JOB}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ job_id: JOB, status: "queued" });
    } finally {
      await app.close();
    }
  });

  it("limits one caller to ten delete requests per minute", async () => {
    const { app } = await build();
    try {
      for (let index = 0; index < 10; index += 1) {
        expect(
          (await app.inject({ method: "POST", url: `/admin/tenants/${TENANT}/delete` })).statusCode,
        ).toBe(202);
      }
      const response = await app.inject({ method: "POST", url: `/admin/tenants/${TENANT}/delete` });
      expect(response.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("fails closed when the rate limiter is unavailable", async () => {
    const { app } = await build({
      rateLimiter: { hit: vi.fn(() => Promise.reject(new Error("redis unavailable"))) },
    });
    try {
      const response = await app.inject({ method: "POST", url: `/admin/tenants/${TENANT}/delete` });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "dependency_unavailable" } });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed tenant and job ids before service access", async () => {
    const { app, service } = await build();
    try {
      const post = await app.inject({ method: "POST", url: "/admin/tenants/not-a-tenant/delete" });
      const get = await app.inject({ method: "GET", url: "/admin/tenant-deletions/not-a-job" });
      expect(post.statusCode).toBe(400);
      expect(get.statusCode).toBe(400);
      expect(service.request).not.toHaveBeenCalled();
      expect(service.find).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns 404 for an unknown deletion job", async () => {
    const { app, service } = await build();
    service.find.mockResolvedValueOnce(null);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/admin/tenant-deletions/${newTenantDeletionJobId()}`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "tenant_deletion_job_not_found" } });
    } finally {
      await app.close();
    }
  });

  it("requires an authenticated caller carrying tenant:delete", async () => {
    const unauthenticated = await build({ authenticated: false });
    const underScoped = await build({ scopes: ["ledger:read"] });
    try {
      expect(
        (
          await unauthenticated.app.inject({
            method: "POST",
            url: `/admin/tenants/${TENANT}/delete`,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await underScoped.app.inject({ method: "POST", url: `/admin/tenants/${TENANT}/delete` }))
          .statusCode,
      ).toBe(403);
    } finally {
      await unauthenticated.app.close();
      await underScoped.app.close();
    }
  });
});
