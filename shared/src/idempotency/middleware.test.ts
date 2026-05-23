import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import idempotencyPlugin, { _internal } from "./middleware.js";
import { InMemoryIdempotencyStore } from "./store.js";

const { serializeBody, coerceToString } = _internal;

describe("serializeBody", () => {
  it("returns empty string for null/undefined", () => {
    expect(serializeBody(null)).toBe("");
    expect(serializeBody(undefined)).toBe("");
  });
  it("returns strings as-is", () => {
    expect(serializeBody("hello")).toBe("hello");
  });
  it("decodes Buffer as utf8", () => {
    expect(serializeBody(Buffer.from("hi"))).toBe("hi");
  });
  it("JSON-stringifies objects", () => {
    expect(serializeBody({ a: 1 })).toBe(`{"a":1}`);
  });
});

describe("coerceToString", () => {
  it("mirrors serializeBody for payload handling", () => {
    expect(coerceToString(null)).toBe("");
    expect(coerceToString("abc")).toBe("abc");
    expect(coerceToString(Buffer.from("abc"))).toBe("abc");
    expect(coerceToString({ a: 1 })).toBe(`{"a":1}`);
  });
});

describe("idempotency plugin on an idempotent route", () => {
  async function buildApp(): Promise<ReturnType<typeof Fastify>> {
    const app = Fastify();
    // Stand in for the auth plugin: set a principal before the idempotency
    // preHandler runs (onRequest precedes preHandler in Fastify).
    app.addHook("onRequest", async (req) => {
      (req as unknown as { principal: { tenantId: string } }).principal = { tenantId: "tnt_test" };
    });
    await app.register(idempotencyPlugin, {
      store: new InMemoryIdempotencyStore(),
      ttlSeconds: 60,
    });
    let counter = 0;
    app.post("/thing", { config: { idempotent: true } }, async (_req, reply) => {
      counter += 1;
      reply.status(201);
      return { n: counter };
    });
    return app;
  }

  it("replays the stored response for the same key + body without re-running the handler", async () => {
    const app = await buildApp();
    const headers = { "idempotency-key": "k1", "content-type": "application/json" };
    const first = await app.inject({ method: "POST", url: "/thing", headers, payload: { a: 1 } });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ n: 1 });
    const second = await app.inject({ method: "POST", url: "/thing", headers, payload: { a: 1 } });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual({ n: 1 });
    expect(second.headers["idempotent-replay"]).toBe("true");
    await app.close();
  });

  it("returns 409 when the same key is reused with a different body", async () => {
    const app = await buildApp();
    const headers = { "idempotency-key": "k2", "content-type": "application/json" };
    await app.inject({ method: "POST", url: "/thing", headers, payload: { a: 1 } });
    const conflict = await app.inject({
      method: "POST",
      url: "/thing",
      headers,
      payload: { a: 2 },
    });
    expect(conflict.statusCode).toBe(409);
    await app.close();
  });

  it("runs the handler each time when no Idempotency-Key is supplied", async () => {
    const app = await buildApp();
    const headers = { "content-type": "application/json" };
    const r1 = await app.inject({ method: "POST", url: "/thing", headers, payload: { a: 1 } });
    const r2 = await app.inject({ method: "POST", url: "/thing", headers, payload: { a: 1 } });
    expect(r1.json()).toEqual({ n: 1 });
    expect(r2.json()).toEqual({ n: 2 });
    await app.close();
  });
});
