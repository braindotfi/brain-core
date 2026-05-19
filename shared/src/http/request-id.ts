/**
 * Brain request-id plugin (Fastify).
 *
 * §6.1 requires every log line to carry `request_id`. This plugin generates
 * (or accepts) one on every incoming request and exposes it as
 * `request.id`. Clients may supply a correlation ID via the `X-Request-Id`
 * header; otherwise we mint a Brain-prefixed ULID.
 *
 * Security: we echo the request id back to the client via `X-Request-Id` on
 * every response for support / trace correlation. If the client sends a
 * bogus header (non-printable, too long), we ignore it and mint a new one
 * rather than trusting foreign input.
 */

import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { newRequestId } from "../ids.js";

const HEADER = "x-request-id";
const MAX_LEN = 128;
const ALLOWED = /^[A-Za-z0-9._:-]+$/;

export function sanitizeRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_LEN) return null;
  if (!ALLOWED.test(raw)) return null;
  return raw;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", async (request, reply) => {
    const supplied = sanitizeRequestId(request.headers[HEADER]);
    const id = supplied ?? newRequestId();
    // Fastify's FastifyRequest.id is writable; use that as the canonical slot.
    (request as unknown as { id: string }).id = id;
    reply.header(HEADER, id);
  });
};

export default fp(plugin, { name: "brain-request-id", fastify: "5.x" });
