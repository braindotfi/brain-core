import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { errorHandlerPlugin, newTenantId } from "@brain/shared";
import {
  registerDemoProvisionAnchorRoute,
  type AnchorPublishFn,
  type AnchorPublishResult,
} from "./anchor-route.js";

const SECRET = "test-provision-secret";
const TENANT = newTenantId();

function sampleAnchor(overrides: Partial<AnchorPublishResult> = {}): AnchorPublishResult {
  return {
    id: "anchor_01TESTANCHOR0000000000000",
    merkle_root: Buffer.alloc(32, 0xab),
    event_count: 7,
    onchain_tx_hash: Buffer.alloc(32, 0xcd),
    onchain_status: "confirmed",
    ...overrides,
  };
}

async function buildApp(deps: {
  publish?: AnchorPublishFn | undefined;
  provisionSecret?: string;
  cooldownMs?: number;
}) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await registerDemoProvisionAnchorRoute(app, {
    provisionSecret: deps.provisionSecret ?? SECRET,
    publish: "publish" in deps ? deps.publish : async () => sampleAnchor(),
    ...(deps.cooldownMs !== undefined ? { cooldownMs: deps.cooldownMs } : {}),
  });
  return app;
}

function inject(app: Awaited<ReturnType<typeof buildApp>>, tenantId: string, secret?: string) {
  return app.inject({
    method: "POST",
    url: `/demo/provision-run/${tenantId}/anchor`,
    headers: secret === undefined ? {} : { "x-demo-provision-auth": secret },
  });
}

describe("POST /v1/demo/provision-run/:tenantId/anchor", () => {
  it("anchors and serializes the row on the happy path", async () => {
    const publish = vi.fn<AnchorPublishFn>(async () => sampleAnchor());
    const app = await buildApp({ publish });
    try {
      const r = await inject(app, TENANT, SECRET);
      expect(r.statusCode).toBe(200);
      const body = r.json() as {
        id: string;
        merkle_root: string;
        event_count: number;
        tx_hash: string;
        basescan_url: string;
        onchain_status: string;
      };
      expect(body.tx_hash).toBe("cd".repeat(32));
      expect(body.merkle_root).toBe("ab".repeat(32));
      expect(body.event_count).toBe(7);
      expect(body.basescan_url).toBe(`https://sepolia.basescan.org/tx/0x${"cd".repeat(32)}`);
      expect(body.onchain_status).toBe("confirmed");
      // publishAnchor is called with the path-param tenant and a ~24h window.
      const arg = publish.mock.calls[0]![0];
      expect(arg.tenantId).toBe(TENANT);
      expect(arg.periodEnd.getTime() - arg.periodStart.getTime()).toBe(24 * 60 * 60 * 1000);
    } finally {
      await app.close();
    }
  });

  it("returns tx_hash null when the row has no on-chain hash yet", async () => {
    const app = await buildApp({ publish: async () => sampleAnchor({ onchain_tx_hash: null }) });
    try {
      const r = await inject(app, TENANT, SECRET);
      expect(r.statusCode).toBe(200);
      const body = r.json() as { tx_hash: string | null; basescan_url: string | null };
      expect(body.tx_hash).toBeNull();
      expect(body.basescan_url).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("rejects a missing secret header with 401", async () => {
    const app = await buildApp({});
    try {
      const r = await inject(app, TENANT);
      expect(r.statusCode).toBe(401);
      expect((r.json() as { error: { code: string } }).error.code).toBe("auth_header_invalid");
    } finally {
      await app.close();
    }
  });

  it("rejects a wrong secret header with 401", async () => {
    const app = await buildApp({});
    try {
      const r = await inject(app, TENANT, "wrong-secret");
      expect(r.statusCode).toBe(401);
      expect((r.json() as { error: { code: string } }).error.code).toBe("auth_header_invalid");
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed tenant id with 400", async () => {
    const app = await buildApp({});
    try {
      const r = await inject(app, "not-a-tenant", SECRET);
      expect(r.statusCode).toBe(400);
      expect((r.json() as { error: { code: string } }).error.code).toBe("auth_tenant_mismatch");
    } finally {
      await app.close();
    }
  });

  it("returns 503 when no broadcaster is configured", async () => {
    const app = await buildApp({ publish: undefined });
    try {
      const r = await inject(app, TENANT, SECRET);
      expect(r.statusCode).toBe(503);
      expect((r.json() as { error: { code: string } }).error.code).toBe("audit_anchor_unavailable");
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the tenant has no audit events in-window", async () => {
    const app = await buildApp({ publish: async () => null });
    try {
      const r = await inject(app, TENANT, SECRET);
      expect(r.statusCode).toBe(404);
      expect((r.json() as { error: { code: string } }).error.code).toBe("audit_no_events");
    } finally {
      await app.close();
    }
  });

  it("rate-limits a second anchor for the same tenant within the cooldown", async () => {
    const publish = vi.fn<AnchorPublishFn>(async () => sampleAnchor());
    const app = await buildApp({ publish, cooldownMs: 60_000 });
    try {
      const first = await inject(app, TENANT, SECRET);
      expect(first.statusCode).toBe(200);
      const second = await inject(app, TENANT, SECRET);
      expect(second.statusCode).toBe(429);
      const body = second.json() as {
        error: { code: string; details: { retry_after_seconds: number } };
      };
      expect(body.error.code).toBe("rate_limited");
      expect(body.error.details.retry_after_seconds).toBeGreaterThan(0);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("does not poison the cooldown when the publish call throws", async () => {
    const publish = vi
      .fn<AnchorPublishFn>()
      .mockRejectedValueOnce(new Error("rpc timeout"))
      .mockResolvedValueOnce(sampleAnchor());
    const app = await buildApp({ publish });
    try {
      const first = await inject(app, TENANT, SECRET);
      expect(first.statusCode).toBe(500);
      // Cooldown was cleared on failure, so an immediate retry is allowed.
      const second = await inject(app, TENANT, SECRET);
      expect(second.statusCode).toBe(200);
      expect(publish).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
