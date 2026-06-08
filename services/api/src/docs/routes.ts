/**
 * Public, read-only API documentation surface.
 *
 *   GET /v1/docs           → Scalar interactive reference (text/html)
 *   GET /v1/docs/scalar.js → the same-origin Scalar standalone bundle
 *   GET /v1/openapi.yaml    → the OpenAPI contract (application/yaml)
 *
 * All three are public (`skipAuth: true`) — the spec is already public-facing,
 * the same rationale as the public `/audit/verify` route. No write path, no
 * tenant data: this is a projection of the checked-in OpenAPI contract.
 *
 * CSP: the global policy (security-headers.ts) is `script-src 'self'` /
 * `style-src 'self'` with per-request nonces. The Scalar bundle injects <style>
 * elements at runtime, which `style-src 'self'` would block. We override the CSP
 * header for THIS plugin's routes only — adding `'unsafe-inline'` to style-src —
 * via an encapsulated onSend hook. `script-src` stays `'self'` (the bundle is
 * same-origin and the page has no inline executable script), and the global
 * policy for every other route is untouched.
 */

import type { FastifyInstance } from "fastify";
import { loadOpenApiSpecText, loadScalarBundle } from "./spec.js";
import { renderDocsHtml } from "./view.js";

/**
 * CSP for the docs subtree. Differs from the global policy only by allowing
 * inline styles (Scalar injects them at runtime). connect-src is 'self' so
 * same-origin "Try it out" works; cross-origin servers (e.g. the sandbox) would
 * need their origin added here.
 */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Route config marking the docs routes as public (no JWT). */
const PUBLIC = { config: { skipAuth: true } } as const;

export async function registerDocsRoutes(app: FastifyInstance): Promise<void> {
  // Read both assets once at registration so a missing spec/bundle fails fast at
  // boot rather than on the first request.
  const specText = loadOpenApiSpecText();
  const bundle = loadScalarBundle();

  // Encapsulated: applies only to routes registered in this plugin scope.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("content-security-policy", DOCS_CSP);
    return payload;
  });

  app.get("/docs", PUBLIC, async (_req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return renderDocsHtml();
  });

  app.get("/docs/scalar.js", PUBLIC, async (_req, reply) => {
    reply.header("content-type", "application/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=3600");
    return bundle;
  });

  app.get("/openapi.yaml", PUBLIC, async (_req, reply) => {
    reply.header("content-type", "application/yaml; charset=utf-8");
    return specText;
  });
}
