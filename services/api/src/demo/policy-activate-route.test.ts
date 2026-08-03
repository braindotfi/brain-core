import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  errorHandlerPlugin,
  requestIdPlugin,
  type Logger,
  type Principal,
  type Scope,
} from "@brain/shared";
import {
  registerDemoPolicyActivateRoute,
  type DemoPolicyActivateRouteDeps,
} from "./policy-activate-route.js";

const TENANT = "tnt_01TEST00000000000000000000";
const POLICY_ID = "pol_01TEST0000000000000000000";

function principal(): Principal {
  return {
    id: "user_01TEST000000000000000000",
    type: "user",
    tenantId: TENANT,
    scopes: ["policy:write", "policy:read"] as Scope[],
    tokenId: "tok_01TEST0000000000000000000",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

function fakeLog(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

/**
 * A fake client matched by query text, mirroring the pattern
 * routes.sign-quorum.test.ts uses for registerPolicyRoutes.
 */
function fakePool(opts: { tenantKind?: "production" | "demo"; hasExisting?: boolean } = {}): Pool {
  const tenantKind = opts.tenantKind ?? "demo";
  const hasExisting = opts.hasExisting ?? false;
  const client = {
    query: async (text: string) => {
      if (/SELECT kind FROM tenants/.test(text)) {
        return { rows: [{ kind: tenantKind }], rowCount: 1 };
      }
      if (/SELECT id, version, onchain_tx, onchain_version FROM policies/.test(text)) {
        return hasExisting
          ? {
              rows: [{ id: POLICY_ID, version: 1, onchain_tx: "0xabc", onchain_version: 1 }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (/state = 'deactivated'/.test(text)) return { rows: [], rowCount: 0 };
      if (/SELECT COALESCE\(MAX\(version\)/.test(text)) {
        return { rows: [{ next_version: 1 }], rowCount: 1 };
      }
      if (/INSERT INTO policies/.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    connect: async () => client,
    query: client.query,
  } as unknown as Pool;
}

/** cfg.BRAIN_POLICY_LINT_REJECT / BRAIN_POLICY_CONFIDENCE_FLOOR_REJECT default
 * to true / false respectively (shared/src/config.ts). Mirror that here so a
 * test that does not override either flag exercises the real deployed default. */
function buildDeps(over: Partial<DemoPolicyActivateRouteDeps> = {}): DemoPolicyActivateRouteDeps {
  return {
    pool: over.pool ?? fakePool(),
    audit: {
      emit: vi.fn(async () => undefined),
    } as unknown as DemoPolicyActivateRouteDeps["audit"],
    log: over.log ?? fakeLog(),
    policyRegistrar: undefined,
    lintReject: over.lintReject ?? true,
    confidenceFloorReject: over.confidenceFloorReject ?? false,
  };
}

async function buildApp(deps: DemoPolicyActivateRouteDeps): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("preHandler", async (req) => {
    req.principal = principal();
  });
  await registerDemoPolicyActivateRoute(app, deps);
  return app;
}

function postActivate(app: FastifyInstance, content?: unknown) {
  return app.inject({
    method: "POST",
    url: "/demo/policy/activate",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(content === undefined ? {} : { content }),
  });
}

describe("POST /v1/demo/policy/activate: H-18 lint gate", () => {
  it("rejects an unbounded auto-executing 'any' money-movement rule", async () => {
    const app = await buildApp(buildDeps());

    const res = await postActivate(app, {
      version: 1,
      rules: [{ id: "unbounded-any-auto", applies_to: ["any"], when: {}, execute: "auto" }],
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe("policy_rule_invalid");
    expect(body.error.details.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "broad_any_auto", severity: "ERROR" }),
        expect.objectContaining({ code: "auto_no_amount_cap", severity: "ERROR" }),
      ]),
    );
    await app.close();
  });

  it("activates a legitimate document through the route", async () => {
    const app = await buildApp(buildDeps());

    const res = await postActivate(app, {
      version: 1,
      rules: [{ id: "default-reject", applies_to: ["any"], when: {}, execute: "reject" }],
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("active");
    await app.close();
  });

  it("activates the built-in DEMO_POLICY when no content is supplied", async () => {
    const app = await buildApp(buildDeps());

    const res = await postActivate(app);

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("active");
    await app.close();
  });

  it("rejects the same unbounded rule for a production tenant even with lintReject unset", async () => {
    const app = await buildApp(
      buildDeps({ pool: fakePool({ tenantKind: "production" }), lintReject: false }),
    );

    const res = await postActivate(app, {
      version: 1,
      rules: [{ id: "unbounded-any-auto", applies_to: ["any"], when: {}, execute: "auto" }],
    });

    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
