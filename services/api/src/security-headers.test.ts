/**
 * P1.4 — security headers test. Bare Fastify app + inject (no DB).
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerSecurityHeaders } from "./security-headers.js";

let app: Awaited<ReturnType<typeof build>> | undefined;

async function build() {
  const a = Fastify({ logger: false });
  await registerSecurityHeaders(a, { connectSrc: ["https://rpc.example.com"] });
  a.get("/v1/ping", async () => ({ ok: true }));
  a.get("/v1/proof/x/view", async (_req, reply) => {
    reply.header("content-type", "text/html");
    return "<html></html>";
  });
  return a;
}

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

describe("registerSecurityHeaders (P1.4)", () => {
  it("sets the full header set on a sample endpoint", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/v1/ping" });
    const h = res.headers;
    expect(h["strict-transport-security"]).toContain("max-age=31536000");
    expect(h["strict-transport-security"]).toContain("includeSubDomains");
    expect(h["strict-transport-security"]).toContain("preload");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["permissions-policy"]).toContain("camera=()");
    const csp = String(h["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("https://rpc.example.com"); // connect-src extra origin
    expect(csp).not.toContain("unsafe-inline");
  });

  it("emits a per-request CSP nonce on script-src and style-src", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/v1/proof/x/view" });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(csp).toMatch(/style-src 'self' 'nonce-[^']+'/);
  });

  it("also applies the headers to the HTML proof view route", async () => {
    app = await build();
    const res = await app.inject({ method: "GET", url: "/v1/proof/x/view" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });
});
