import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSecurityHeaders } from "../security-headers.js";
import { registerDocsRoutes } from "./routes.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Global strict CSP, exactly as main.ts wires it.
  await registerSecurityHeaders(app, { connectSrc: [] });
  await app.register(
    async (v1) => {
      await v1.register(async (child) => registerDocsRoutes(child));
      // A sibling, non-docs route to prove the global CSP is untouched.
      v1.get("/ping", async () => ({ ok: true }));
    },
    { prefix: "/v1" },
  );
  await app.ready();
  return app;
}

describe("docs routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /v1/docs serves the HTML reference page", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/docs" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('data-url="/v1/openapi.yaml"');
    expect(res.body).toContain('src="/v1/docs/scalar.js"');
  });

  it("GET /v1/docs relaxes style-src but keeps script-src strict (route-scoped)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/docs" });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("GET /v1/openapi.yaml serves the contract as YAML", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.yaml" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/yaml");
    expect(res.body.startsWith("openapi: 3.1")).toBe(true);
  });

  it("GET /v1/docs/scalar.js serves the renderer bundle", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/docs/scalar.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
    expect(res.body.length).toBeGreaterThan(100_000);
  });

  it("does not leak the relaxed CSP to sibling routes", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/ping" });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers["content-security-policy"]);
    // Global policy keeps style-src locked down (nonce-based, no unsafe-inline).
    expect(csp).not.toContain("'unsafe-inline'");
  });
});
