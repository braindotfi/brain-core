import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { brainError, errorHandlerPlugin, requestIdPlugin, type Principal } from "@brain/shared";

const { verifySiwxProof } = vi.hoisted(() => ({ verifySiwxProof: vi.fn() }));
vi.mock("../auth/siwx.js", () => ({ verifySiwxProof }));

import { registerOnchainSignerRoutes } from "./onchain-signer.js";

const TENANT = "tnt_01J0000000000000000000000Z";
const OTHER_TENANT = "tnt_01J0000000000000000000000Q";
const ADDR = "0xAbCdEf0000000000000000000000000000000001";

interface Captured {
  sql: string;
  values: unknown[];
}

function makePool(opts: { walletLinked: boolean }): { pool: Pool; calls: Captured[] } {
  const calls: Captured[] = [];
  const client = {
    query: vi.fn((sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("SELECT set_config")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("FROM wallet_identities")) {
        return Promise.resolve({
          rows: opts.walletLinked ? [{ address: ADDR.toLowerCase() }] : [],
          rowCount: opts.walletLinked ? 1 : 0,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(() => Promise.resolve(client)) } as unknown as Pool, calls };
}

function ownerPrincipal(
  tenantId: string,
  opts: { type?: "user" | "agent"; scopes?: string[] } = {},
): Principal {
  return {
    id: "user_owner",
    type: opts.type ?? "user",
    tenantId,
    scopes: (opts.scopes ?? ["policy:write"]) as unknown as Principal["scopes"],
    tokenId: "tok_test",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

async function buildApp(pool: Pool, principal: Principal): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  app.addHook("onRequest", async (req) => {
    req.principal = principal;
  });
  await registerOnchainSignerRoutes(app, {
    pool,
    audit: { emit: vi.fn(async () => undefined) } as unknown as Parameters<
      typeof registerOnchainSignerRoutes
    >[1]["audit"],
    redis: {} as Redis,
  });
  await app.ready();
  return app;
}

const VALID_BODY = { address: ADDR, message: "siwe-message", signature: "0xsig" };

describe("POST /tenants/:tenant_id/onchain-signer — RFC 0002 Phase C increment 4", () => {
  it("designates the signer when the wallet is linked and a fresh SIWX proof matches", async () => {
    verifySiwxProof.mockReset().mockResolvedValue(ADDR.toLowerCase());
    const { pool, calls } = makePool({ walletLinked: true });
    const app = await buildApp(pool, ownerPrincipal(TENANT));
    const res = await app.inject({
      method: "POST",
      url: `/tenants/${TENANT}/onchain-signer`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenant_id: TENANT, onchain_signer_address: ADDR.toLowerCase() });
    expect(calls.some((c) => /UPDATE tenants SET onchain_signer_address/.test(c.sql))).toBe(true);
    await app.close();
  });

  it("rejects when the address is not already linked in wallet_identities", async () => {
    verifySiwxProof.mockReset();
    const { pool, calls } = makePool({ walletLinked: false });
    const app = await buildApp(pool, ownerPrincipal(TENANT));
    const res = await app.inject({
      method: "POST",
      url: `/tenants/${TENANT}/onchain-signer`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("onchain_signer_wallet_not_linked");
    // Never even attempts SIWX verification for an unlinked address.
    expect(verifySiwxProof).not.toHaveBeenCalled();
    expect(calls.some((c) => /UPDATE tenants/.test(c.sql))).toBe(false);
    await app.close();
  });

  it("rejects when the SIWX proof recovers a different address than requested", async () => {
    verifySiwxProof.mockReset().mockResolvedValue("0x" + "ff".repeat(20));
    const { pool, calls } = makePool({ walletLinked: true });
    const app = await buildApp(pool, ownerPrincipal(TENANT));
    const res = await app.inject({
      method: "POST",
      url: `/tenants/${TENANT}/onchain-signer`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth_siwx_invalid");
    expect(calls.some((c) => /UPDATE tenants/.test(c.sql))).toBe(false);
    await app.close();
  });

  it("propagates a SIWX verification failure (bad nonce/signature) unchanged", async () => {
    verifySiwxProof
      .mockReset()
      .mockRejectedValue(brainError("auth_siwx_invalid", "SIWX session_id missing or expired"));
    const { pool } = makePool({ walletLinked: true });
    const app = await buildApp(pool, ownerPrincipal(TENANT));
    const res = await app.inject({
      method: "POST",
      url: `/tenants/${TENANT}/onchain-signer`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a path tenant_id that does not match the token (cross-tenant)", async () => {
    verifySiwxProof.mockReset();
    const { pool } = makePool({ walletLinked: true });
    const app = await buildApp(pool, ownerPrincipal(TENANT));
    const res = await app.inject({
      method: "POST",
      url: `/tenants/${OTHER_TENANT}/onchain-signer`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("auth_tenant_mismatch");
    expect(verifySiwxProof).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an agent principal (user principal only)", async () => {
    verifySiwxProof.mockReset();
    const { pool } = makePool({ walletLinked: true });
    const app = await buildApp(pool, ownerPrincipal(TENANT, { type: "agent" }));
    const res = await app.inject({
      method: "POST",
      url: `/tenants/${TENANT}/onchain-signer`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("auth_scope_insufficient");
    await app.close();
  });

  it("rejects a principal without policy:write", async () => {
    verifySiwxProof.mockReset();
    const { pool } = makePool({ walletLinked: true });
    const app = await buildApp(pool, ownerPrincipal(TENANT, { scopes: ["ledger:read"] }));
    const res = await app.inject({
      method: "POST",
      url: `/tenants/${TENANT}/onchain-signer`,
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
