import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandlerPlugin, newTenantId, type Principal, type Scope } from "@brain/shared";
import type { Pool } from "pg";
import { deriveAuditHealthStatus, registerAuditHealthRoute } from "./route.js";
import type { AuditVerifierHealth } from "@brain/audit";
import type { AuditOutboxHealth } from "../tenant-deletion/blob-purge-audit-outbox.js";

const TENANT = newTenantId();

function principal(scopes: Scope[]): Principal {
  return {
    id: "user_1",
    type: "user",
    tenantId: TENANT,
    scopes,
    tokenId: "jti_1",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

/** Privileged pool serving the 3 verifier queries + the 1 outbox query. */
function fakePool(opts: {
  checkpoint?: Record<string, unknown> | null;
  open?: number;
  unsupported?: number;
  legacy?: number;
  pending?: number;
  exhausted?: number;
}): Pool {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("FROM audit_verifier_checkpoint")) {
        return {
          rows: opts.checkpoint === null || opts.checkpoint === undefined ? [] : [opts.checkpoint],
          rowCount: 1,
        };
      }
      if (text.includes("FROM audit_integrity_findings")) {
        return { rows: [{ n: String(opts.open ?? 0) }], rowCount: 1 };
      }
      if (text.includes("FILTER (WHERE hash_schema_version >")) {
        return {
          rows: [{ unsupported: String(opts.unsupported ?? 0), legacy: String(opts.legacy ?? 0) }],
          rowCount: 1,
        };
      }
      if (text.includes("FROM tenant_blob_purge_audit_outbox")) {
        return {
          rows: [
            {
              pending: opts.pending ?? 0,
              exhausted: opts.exhausted ?? 0,
              oldest_pending_age_s: 0,
              oldest_exhausted_age_s: 0,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
}

const cleanCheckpoint = {
  last_pass_status: "clean",
  last_clean_pass_at: new Date("2026-06-08T00:00:00.000Z"),
  last_failed_pass_at: null,
  last_full_pass_at: new Date("2026-06-08T00:00:00.000Z"),
  completed_passes: "5",
  current_pass_failure_count: "0",
  seconds_since_clean: 30,
};

async function buildApp(pool: Pool, scopes: Scope[]): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  app.addHook("onRequest", async (req) => {
    req.principal = principal(scopes);
  });
  registerAuditHealthRoute(app, { privilegedPool: pool });
  return app;
}

describe("deriveAuditHealthStatus", () => {
  const base: AuditVerifierHealth = {
    lastPassStatus: "clean",
    lastCleanPassAt: "2026-06-08T00:00:00.000Z",
    lastFailedPassAt: null,
    lastFullPassAt: "2026-06-08T00:00:00.000Z",
    completedPasses: 5,
    currentPassFailureCount: 0,
    secondsSinceCleanFullPass: 30,
    openFindings: 0,
    unsupportedVersion: 0,
    legacyUnverifiable: 0,
  };
  const outbox: AuditOutboxHealth = {
    pending: 0,
    exhausted: 0,
    oldestPendingAgeSeconds: 0,
    oldestExhaustedAgeSeconds: 0,
  };

  it("is safe on a clean pass with no findings/exhausted evidence", () => {
    expect(deriveAuditHealthStatus(base, outbox)).toBe("safe");
  });

  it("is critical on a failed pass, an open finding, or an exhausted outbox row", () => {
    expect(deriveAuditHealthStatus({ ...base, lastPassStatus: "failed" }, outbox)).toBe("critical");
    expect(deriveAuditHealthStatus({ ...base, openFindings: 1 }, outbox)).toBe("critical");
    expect(deriveAuditHealthStatus(base, { ...outbox, exhausted: 1 })).toBe("critical");
  });

  it("is degraded when no clean pass yet, or unverifiable versions exist", () => {
    expect(deriveAuditHealthStatus({ ...base, lastPassStatus: "never" }, outbox)).toBe("degraded");
    expect(deriveAuditHealthStatus({ ...base, legacyUnverifiable: 4 }, outbox)).toBe("degraded");
    expect(deriveAuditHealthStatus({ ...base, unsupportedVersion: 1 }, outbox)).toBe("degraded");
  });
});

describe("GET /internal/audit/health", () => {
  it("returns 200 + a safe snapshot for an audit:admin principal", async () => {
    const app = await buildApp(fakePool({ checkpoint: cleanCheckpoint }), ["audit:admin"]);
    const res = await app.inject({ method: "GET", url: "/internal/audit/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("safe");
    expect(body.verifier.lastPassStatus).toBe("clean");
    expect(body.verifier.completedPasses).toBe(5);
    expect(body.outbox.exhausted).toBe(0);
  });

  it("rolls up to critical when an integrity finding is open", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = await buildApp(fakePool({ checkpoint: cleanCheckpoint, open: 1 }), ["audit:admin"]);
    const res = await app.inject({ method: "GET", url: "/internal/audit/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("critical");
    errSpy.mockRestore();
  });

  it("forbids a principal without audit:admin (audit:read is not enough)", async () => {
    const app = await buildApp(fakePool({ checkpoint: cleanCheckpoint }), ["audit:read"]);
    const res = await app.inject({ method: "GET", url: "/internal/audit/health" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("auth_scope_insufficient");
  });
});
