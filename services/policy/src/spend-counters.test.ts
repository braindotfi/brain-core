import { describe, expect, it } from "vitest";
import { bucketStart } from "./spend-counters.js";

describe("bucketStart (tumbling windows)", () => {
  it("aligns 1h buckets to the hour", () => {
    expect(bucketStart("1h", new Date("2026-05-23T14:37:12Z")).toISOString()).toBe(
      "2026-05-23T14:00:00.000Z",
    );
  });

  it("aligns 24h buckets to the UTC day", () => {
    expect(bucketStart("24h", new Date("2026-05-23T14:37:12Z")).toISOString()).toBe(
      "2026-05-23T00:00:00.000Z",
    );
  });

  it("is stable within a bucket and advances across the boundary", () => {
    const a = bucketStart("1h", new Date("2026-05-23T14:00:00Z"));
    const b = bucketStart("1h", new Date("2026-05-23T14:59:59Z"));
    const c = bucketStart("1h", new Date("2026-05-23T15:00:00Z"));
    expect(a.getTime()).toBe(b.getTime());
    expect(c.getTime()).toBeGreaterThan(a.getTime());
  });

  it("falls back to the epoch for an unknown window", () => {
    expect(bucketStart("99q", new Date()).getTime()).toBe(0);
  });
});
