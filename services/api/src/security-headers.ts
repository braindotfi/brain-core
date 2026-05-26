/**
 * P1.4 — CSP and security headers for the API gateway.
 *
 * Replaces the prior `contentSecurityPolicy: false` helmet registration with a
 * restrictive default. Inline <style>/<script> (the proof view) must carry a
 * per-request nonce (reply.cspNonce) — never 'unsafe-inline'. Extracted into a
 * function so it is unit-testable on a bare Fastify app.
 */

import fastifyHelmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";

export interface SecurityHeadersOptions {
  /** Origins allowed for connect-src beyond 'self' (e.g. the CORS allowlist). */
  connectSrc?: string[];
}

const PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

export async function registerSecurityHeaders(
  app: FastifyInstance,
  opts: SecurityHeadersOptions = {},
): Promise<void> {
  const connectSrc = ["'self'", ...(opts.connectSrc ?? [])];

  await app.register(fastifyHelmet, {
    // Per-request nonces appended to script-src/style-src so the proof view's
    // inline <style nonce> works without 'unsafe-inline'.
    enableCSPNonces: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc,
        imgSrc: ["'self'", "data:"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    // X-Content-Type-Options: nosniff is on by default.
  });

  // Permissions-Policy: helmet no longer emits this — lock features to none.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Permissions-Policy", PERMISSIONS_POLICY);
  });
}
