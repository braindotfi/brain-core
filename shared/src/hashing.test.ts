import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { hashStream, teeSha256 } from "./hashing.js";

const HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("hashStream", () => {
  it("computes sha256 + byte count for a small stream", async () => {
    const { sha256, bytes } = await hashStream(Readable.from(["hello"]));
    expect(sha256).toBe(HELLO_SHA);
    expect(bytes).toBe(5);
  });

  it("handles multi-chunk streams", async () => {
    const { sha256, bytes } = await hashStream(Readable.from(["he", "ll", "o"]));
    expect(sha256).toBe(HELLO_SHA);
    expect(bytes).toBe(5);
  });
});

describe("teeSha256", () => {
  it("passes bytes through unchanged and reports hash when done", async () => {
    const input = Readable.from(["hel", "lo"]);
    const { bytesOut, done } = teeSha256(input);
    const chunks: Buffer[] = [];
    for await (const c of bytesOut) chunks.push(Buffer.from(c as Buffer));
    const result = await done;
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    expect(result.sha256).toBe(HELLO_SHA);
    expect(result.bytes).toBe(5);
  });
});
