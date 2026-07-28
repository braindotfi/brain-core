/**
 * CSP + security headers for the AS's HTML surface (/login, /set-password,
 * /forgot-password). services/api/src/security-headers.ts is NOT importable
 * here: @brain/api's package.json "exports" only declares ".", which pulls in
 * the whole API's boot (Phase 1's server.ts already found and recorded this).
 * So this sets the same headers directly rather than depending on @brain/api.
 *
 * Differs from @brain/api's registerSecurityHeaders in exactly one place:
 * `frameAncestors: 'none'` here (clickjacking on an auth/consent surface is
 * the classic attack) where the api's is also 'none' -- so in practice this
 * mirrors it, just declared independently per the note above.
 */

import fastifyHelmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";

export async function registerAuthSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHelmet, {
    enableCSPNonces: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
  });
}
