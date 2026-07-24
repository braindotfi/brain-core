import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { extractBearer } from "./middleware.js";
import authPlugin from "./middleware.js";
import requestIdPlugin from "../http/request-id.js";
import { InMemoryAuditEmitter } from "../audit/emitter.js";
import { CorrelatingAuditEmitter } from "../correlation.js";
import type { JwtVerifier } from "./jwt.js";
import type { Principal } from "./principal.js";

describe("extractBearer", () => {
  it("extracts the token when header is well-formed", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearer("bearer token")).toBe("token");
    expect(extractBearer("BEARER token")).toBe("token");
  });

  it("trims whitespace around the header", () => {
    expect(extractBearer("  Bearer abc  ")).toBe("abc");
  });

  it("returns null for unknown schemes", () => {
    expect(extractBearer("Basic abc")).toBe(null);
  });

  it("returns null for missing header", () => {
    expect(extractBearer(undefined)).toBe(null);
  });

  it("returns null for empty header", () => {
    expect(extractBearer("")).toBe(null);
    expect(extractBearer("Bearer")).toBe(null);
  });
});

// Review P2: prior code relied entirely on CorrelatingAuditEmitter pulling
// keyId out of AsyncLocalStorage for the api-key usage-tracking audit event.
// Live testing (sequential + 20-request concurrent, two different keys)
// showed ALS attribution actually works correctly in this codebase, but the
// design was still fragile, request.apiKeyId was already in scope at the
// emit() call site and simply wasn't being used. This suite proves the fix
// (passing keyId explicitly) with a plain, non-ALS-wrapping emitter, so
// there is zero dependency on AsyncLocalStorage for this specific test.
describe("onResponse api key usage attribution (no ALS involved)", () => {
  const fakePrincipal: Principal = {
    id: "agent_test",
    type: "api_partner",
    tenantId: "tnt_test",
    scopes: ["ledger:read"],
    tokenId: "token_test",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  async function buildApp(audit: InMemoryAuditEmitter, keyId: string) {
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as unknown as JwtVerifier, // unused: only the api-key path is exercised
      apiKeyAuthenticator: async (secret: string) =>
        secret === "brain_sk_test_valid" ? { principal: fakePrincipal, keyId } : null,
      apiKeyUsageAudit: audit,
    });
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();
    return app;
  }

  it("attributes keyId directly on the emitted event, with no CorrelatingAuditEmitter in the chain", async () => {
    const audit = new InMemoryAuditEmitter();
    const app = await buildApp(audit, "akey_direct_test");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/probe",
        headers: { authorization: "Bearer brain_sk_test_valid" },
      });
      expect(res.statusCode).toBe(200);
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({ keyId: "akey_direct_test", action: "http.request" });
    } finally {
      await app.close();
    }
  });

  it("does not record usage for a non-2xx response", async () => {
    const audit = new InMemoryAuditEmitter();
    const app = Fastify({ logger: false });
    await app.register(authPlugin, {
      verifier: {} as unknown as JwtVerifier,
      apiKeyAuthenticator: async (secret: string) =>
        secret === "brain_sk_test_valid"
          ? { principal: fakePrincipal, keyId: "akey_should_not_appear" }
          : null,
      apiKeyUsageAudit: audit,
    });
    app.get("/fails", async (_req, reply) => {
      reply.status(500);
      return { error: "boom" };
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/fails",
        headers: { authorization: "Bearer brain_sk_test_valid" },
      });
      expect(res.statusCode).toBe(500);
      expect(audit.events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

// Same property as above, but on ONE app with a shared emitter wrapped in
// CorrelatingAuditEmitter, matching the real wiring in services/api/src/main.ts
// (~line 499 constructs it, ~line 1701 passes it as apiKeyUsageAudit). Two
// different presented secrets resolve to two different key ids; interleaved
// concurrent requests for both must never cross-attribute. Unlike a two-app
// setup (structurally incapable of crossover), this one app / one emitter /
// two keys shape would catch a regression back to ALS-only attribution
// (e.g. AsyncLocalStorage context bleeding between concurrent requests).
describe("onResponse api key usage attribution (via CorrelatingAuditEmitter)", () => {
  const fakePrincipal: Principal = {
    id: "agent_test",
    type: "api_partner",
    tenantId: "tnt_test",
    scopes: ["ledger:read"],
    tokenId: "token_test",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  it("keeps two concurrent keys' events correctly isolated with no crossover", async () => {
    const inner = new InMemoryAuditEmitter();
    const audit = new CorrelatingAuditEmitter(inner);
    const app = Fastify({ logger: false });
    // Registration order matches production (services/api/src/main.ts):
    // request-id/correlation plugin BEFORE auth. Each request gets its own
    // AsyncLocalStorage context from beginRequestAuditContext, which is what
    // the dedupe guard (currentRequestHasApiKeyAuditEvent) in middleware.ts
    // relies on to stay per-request instead of leaking across concurrent
    // requests sharing one app instance.
    await app.register(requestIdPlugin);
    await app.register(authPlugin, {
      verifier: {} as unknown as JwtVerifier, // unused: only the api-key path is exercised
      apiKeyAuthenticator: async (secret: string) => {
        if (secret === "brain_sk_test_A") return { principal: fakePrincipal, keyId: "akey_A" };
        if (secret === "brain_sk_test_B") return { principal: fakePrincipal, keyId: "akey_B" };
        return null;
      },
      apiKeyUsageAudit: audit,
    });
    app.get("/probe", async () => ({ ok: true }));
    await app.ready();
    try {
      // Both batches fire immediately (Array.from invokes app.inject eagerly),
      // so key A and key B requests are genuinely in flight concurrently on
      // the same app / same shared emitter.
      const results = await Promise.all([
        ...Array.from({ length: 10 }, () =>
          app.inject({
            method: "GET",
            url: "/probe",
            headers: { authorization: "Bearer brain_sk_test_A" },
          }),
        ),
        ...Array.from({ length: 10 }, () =>
          app.inject({
            method: "GET",
            url: "/probe",
            headers: { authorization: "Bearer brain_sk_test_B" },
          }),
        ),
      ]);
      for (const res of results) {
        expect(res.statusCode).toBe(200);
      }

      expect(inner.events).toHaveLength(20);
      expect(inner.events.filter((e) => e.keyId === "akey_A")).toHaveLength(10);
      expect(inner.events.filter((e) => e.keyId === "akey_B")).toHaveLength(10);
      expect(inner.events.every((e) => e.keyId === "akey_A" || e.keyId === "akey_B")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
