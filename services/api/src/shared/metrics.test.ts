import { describe, expect, it } from "vitest";
import { MockMetrics, createMetrics } from "./metrics.js";

describe("createMetrics (mock mode)", () => {
  it("returns a MockMetrics that captures increment / gauge / histogram / duration", () => {
    const m = createMetrics({
      host: "ignored",
      port: 0,
      prefix: "brain.",
      mock: true,
    });
    expect(m).toBeInstanceOf(MockMetrics);
    m.increment("foo.bar", { a: "1" });
    m.gauge("foo.g", 42, { env: "dev" });
    m.histogram("foo.h", 7);
    m.duration("foo.d", 120, { endpoint: "/raw/ingest" });
    const captured = (m as MockMetrics).calls;
    expect(captured).toHaveLength(4);
    expect(captured[0]).toMatchObject({
      kind: "increment",
      name: "foo.bar",
      value: 1,
      tags: { a: "1" },
    });
    expect(captured[1]).toMatchObject({
      kind: "gauge",
      name: "foo.g",
      value: 42,
    });
    expect(captured[2]).toMatchObject({ kind: "histogram", name: "foo.h" });
    expect(captured[3]).toMatchObject({
      kind: "duration",
      name: "foo.d",
      value: 120,
      tags: { endpoint: "/raw/ingest" },
    });
  });

  it("honors explicit increment value", () => {
    const m = new MockMetrics();
    m.increment("c.x", undefined, 5);
    expect(m.calls[0]).toMatchObject({ kind: "increment", value: 5 });
  });

  it("close is idempotent and resolves", async () => {
    const m = new MockMetrics();
    await expect(m.close()).resolves.toBeUndefined();
  });
});
