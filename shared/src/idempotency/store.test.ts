import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore, hashBody, idempotencyRedisKey } from "./store.js";

const TENANT = "tnt_01HQ7K3ABCDEFGHJKMNPQRSTV";

describe("idempotencyRedisKey", () => {
  it("namespaces by tenant and key", () => {
    expect(idempotencyRedisKey(TENANT, "order-123")).toBe(`idemp:${TENANT}:order-123`);
  });
});

describe("hashBody", () => {
  it("is deterministic and differs across inputs", () => {
    const a = hashBody(`{"amount":100}`);
    const b = hashBody(`{"amount":100}`);
    const c = hashBody(`{"amount":101}`);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });

  it("accepts Uint8Array input", () => {
    const a = hashBody(Buffer.from("hi"));
    const b = hashBody("hi");
    expect(a).toBe(b);
  });
});

describe("InMemoryIdempotencyStore", () => {
  it("miss on first probe, done after complete", async () => {
    const store = new InMemoryIdempotencyStore();
    const input = { tenantId: TENANT, key: "k1", bodyHash: "h1", ttlSeconds: 60 };

    const first = await store.probeAndMark(input);
    expect(first.state).toBe("miss");

    await store.complete({
      ...input,
      response: { status: 201, body: `{"ok":true}` },
    });

    const second = await store.probeAndMark(input);
    expect(second.state).toBe("done");
    if (second.state === "done") {
      expect(second.response.status).toBe(201);
      expect(second.response.body).toBe(`{"ok":true}`);
    }
  });

  it("in_flight on re-probe with same body hash before complete", async () => {
    const store = new InMemoryIdempotencyStore();
    const input = { tenantId: TENANT, key: "k2", bodyHash: "h2", ttlSeconds: 60 };
    expect((await store.probeAndMark(input)).state).toBe("miss");
    const retry = await store.probeAndMark(input);
    expect(retry.state).toBe("in_flight");
  });

  it("conflict when body hash differs from stored in-flight", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.probeAndMark({
      tenantId: TENANT,
      key: "k3",
      bodyHash: "hA",
      ttlSeconds: 60,
    });
    const conflict = await store.probeAndMark({
      tenantId: TENANT,
      key: "k3",
      bodyHash: "hB",
      ttlSeconds: 60,
    });
    expect(conflict.state).toBe("conflict");
    if (conflict.state === "conflict") {
      expect(conflict.storedBodyHash).toBe("hA");
      expect(conflict.suppliedBodyHash).toBe("hB");
    }
  });

  it("conflict when body hash differs from stored done", async () => {
    const store = new InMemoryIdempotencyStore();
    const base = { tenantId: TENANT, key: "k4", ttlSeconds: 60 };
    await store.probeAndMark({ ...base, bodyHash: "hA" });
    await store.complete({
      ...base,
      bodyHash: "hA",
      response: { status: 200, body: "{}" },
    });
    const conflict = await store.probeAndMark({ ...base, bodyHash: "hZ" });
    expect(conflict.state).toBe("conflict");
  });

  it("discard removes the marker so a retry starts fresh", async () => {
    const store = new InMemoryIdempotencyStore();
    const input = { tenantId: TENANT, key: "k5", bodyHash: "h5", ttlSeconds: 60 };
    await store.probeAndMark(input);
    await store.discard(input);
    const retry = await store.probeAndMark(input);
    expect(retry.state).toBe("miss");
  });

  it("entries self-expire after TTL elapses", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.probeAndMark({
      tenantId: TENANT,
      key: "k6",
      bodyHash: "h6",
      ttlSeconds: -1,
    });
    const retry = await store.probeAndMark({
      tenantId: TENANT,
      key: "k6",
      bodyHash: "h6",
      ttlSeconds: 60,
    });
    expect(retry.state).toBe("miss");
  });

  it("treats corrupted entries as miss (recovery path)", async () => {
    const store = new InMemoryIdempotencyStore();
    // Seed a corrupt entry directly.
    // @ts-expect-error - reaching into private for test only
    store.entries.set(idempotencyRedisKey(TENANT, "kx"), {
      raw: "not-json",
      expiresAt: Date.now() + 60_000,
    });
    const probed = await store.probeAndMark({
      tenantId: TENANT,
      key: "kx",
      bodyHash: "h",
      ttlSeconds: 60,
    });
    expect(probed.state).toBe("miss");
  });
});
