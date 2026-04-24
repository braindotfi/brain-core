import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "./types.js";
import { redisConnectionFromUrl } from "./factory.js";

describe("QUEUE_NAMES", () => {
  it("uses the brain.<layer>.<op> convention", () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(name).toMatch(/^brain\.[a-z]+\.[a-z_]+$/);
    }
  });
  it("has no collisions", () => {
    const values = Object.values(QUEUE_NAMES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("redisConnectionFromUrl", () => {
  it("parses hostname + port", () => {
    const c = redisConnectionFromUrl("redis://localhost:6380");
    expect(c).toMatchObject({ host: "localhost", port: 6380, maxRetriesPerRequest: null });
  });

  it("defaults port to 6379 when absent", () => {
    const c = redisConnectionFromUrl("redis://r.example.com");
    expect(c).toMatchObject({ port: 6379 });
  });

  it("carries username and password when present", () => {
    const c = redisConnectionFromUrl("redis://u:p@r.example.com:6380");
    expect(c).toMatchObject({ host: "r.example.com", username: "u", password: "p" });
  });

  it("omits auth when absent", () => {
    const c = redisConnectionFromUrl("redis://localhost:6379") as Record<string, unknown>;
    expect(c).not.toHaveProperty("username");
    expect(c).not.toHaveProperty("password");
  });
});
