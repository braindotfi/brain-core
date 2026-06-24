/**
 * Tests for the RFC 9728 OAuth protected-resource metadata route.
 *
 * Uses Fastify's inject() so no network port is opened. The route is public
 * (`skipAuth`) and carries no tenant data, so no auth plugin is needed.
 */

import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  OAUTH_PROTECTED_RESOURCE_PATH,
  registerOAuthProtectedResourceRoute,
  resourceMetadataUrl,
  type OAuthProtectedResourceMetadata,
} from "./oauth-protected-resource.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerOAuthProtectedResourceRoute(app, {
    resource: "https://mcp.brain.fi",
    authorizationServers: ["https://auth.brain.fi"],
    scopesSupported: ["ledger:read", "wiki:read"],
  });
  return app;
}

describe("resourceMetadataUrl", () => {
  it("appends the well-known path to a bare origin", () => {
    expect(resourceMetadataUrl("https://mcp.brain.fi")).toBe(
      "https://mcp.brain.fi/.well-known/oauth-protected-resource",
    );
  });

  it("does not double the slash when the resource has a trailing slash", () => {
    expect(resourceMetadataUrl("https://mcp.brain.fi/")).toBe(
      "https://mcp.brain.fi/.well-known/oauth-protected-resource",
    );
  });
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("serves the RFC 9728 metadata document as JSON", async () => {
    const app = await buildApp();
    try {
      const r = await app.inject({ method: "GET", url: OAUTH_PROTECTED_RESOURCE_PATH });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toContain("application/json");
      const body = r.json() as OAuthProtectedResourceMetadata;
      expect(body.resource).toBe("https://mcp.brain.fi");
      expect(body.authorization_servers).toEqual(["https://auth.brain.fi"]);
      expect(body.scopes_supported).toEqual(["ledger:read", "wiki:read"]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
    } finally {
      await app.close();
    }
  });
});
