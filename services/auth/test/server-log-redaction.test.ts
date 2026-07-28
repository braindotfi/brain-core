/**
 * Finding 2: the previous `{ redact: { paths: ["req.query", ...] } }` config
 * did nothing -- Fastify 5's default `req` serializer never puts a `query`
 * or `headers` key on the logged object, so pino had nothing to redact and
 * the raw `/set-password?tid=...&t=<token>` query string, bearer token
 * included, was written to the log destination verbatim on every request.
 *
 * This boots the REAL `buildAuthApp` with its REAL (non-`false`) logger
 * option -- not a mock -- and captures actual pino output during a real
 * `app.inject` call via `loggerStream`, so a future regression that drops
 * or breaks `reqSerializer` fails this test with the token present in the
 * assertion output, not merely by re-reading server.ts's config.
 *
 * `loggerStream` is required rather than intercepting process.stdout.write:
 * pino's default destination (sonic-boom) writes directly to fd 1, bypassing
 * `process.stdout.write` entirely -- verified live, an stdout-hijack capture
 * always observed zero bytes even though the real log line (with the raw
 * token, before this fix) was visibly printed to the terminal.
 */

import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateSignKeyJwk, InMemoryAuditEmitter } from "@brain/shared";
import { buildAuthApp } from "../src/server.js";

const RAW_TOKEN = "THE_RAW_SET_PASSWORD_TOKEN_do-not-log-me-1234567890";

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) await app.close();
  app = undefined;
});

function collectingStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join("") };
}

describe("buildAuthApp request logging never writes the query string", () => {
  it("does not log the raw set-password token, on a REAL matched /set-password route", async () => {
    const jwk = await generateSignKeyJwk();
    const { stream, text } = collectingStream();
    app = await buildAuthApp({
      issuer: "https://auth.brain.fi",
      signKey: JSON.stringify(jwk),
      serviceName: "brain-auth",
      serviceVersion: "0.0.0-dev",
      commit: "deadbeef",
      // Deliberately NOT `logger: false` -- this must exercise the real
      // production logger config, the whole point of this test.
      loggerStream: stream,
      humanAuth: {
        // An invalid tid short-circuits routes/human-auth.ts's isBrainId
        // check before the pool is ever touched, so an empty stub is enough
        // to reach a real 404 render through the REAL registered route
        // (never Fastify's internal route-not-found handler, which is a
        // different, non-regressed code path outside this finding).
        authPool: {} as never,
        credentialReader: {
          resolveByEmail: async () => null,
          resolveAnyByEmail: async () => null,
        },
        cookieSecret: "test-cookie-secret-do-not-use-in-prod",
        audit: new InMemoryAuditEmitter(),
        deliverForgotPasswordEmail: async () => true,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/set-password?tid=not-a-real-tenant-id&t=${RAW_TOKEN}`,
    });

    expect(res.statusCode).toBe(404);
    const logged = text();
    expect(logged).not.toContain(RAW_TOKEN);
    // Proves the assertion above isn't vacuous: a request log line for this
    // route really was captured, just without the query string.
    expect(logged).toContain('"url":"/set-password"');
  });
});
