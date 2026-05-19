import { describe, expect, it } from "vitest";
import { MemoryBlobAdapter } from "./memory.js";
import { blobPath, sha256Hex } from "./types.js";
import { createBlobAdapter } from "./factory.js";

describe("blobPath", () => {
  it("builds tenant-prefixed yyyy/mm/dd/sha path", () => {
    const at = new Date("2026-04-24T12:00:00Z");
    expect(blobPath("tnt_01HQ7K3", "abc", at)).toBe("tnt_01HQ7K3/2026/04/24/abc");
  });

  it("zero-pads month and day", () => {
    const at = new Date("2026-01-03T00:00:00Z");
    expect(blobPath("t", "s", at)).toBe("t/2026/01/03/s");
  });
});

describe("sha256Hex", () => {
  it("produces a 64-char lowercase hex digest", () => {
    const sha = sha256Hex(Buffer.from("hello"));
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(sha).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("MemoryBlobAdapter", () => {
  it("stores and retrieves bytes round-trip", async () => {
    const a = new MemoryBlobAdapter();
    const res = await a.put("tnt/1/2/3/xyz", Buffer.from("hello"), { contentType: "text/plain" });
    expect(res.bytes).toBe(5);
    expect(res.mimeType).toBe("text/plain");
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);

    const stream = await a.get("tnt/1/2/3/xyz");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe("hello");
  });

  it("tombstone marks metadata but preserves bytes (§3 Layer 1 immutability)", async () => {
    const a = new MemoryBlobAdapter();
    await a.put("p", Buffer.from("x"), {});
    await a.tombstone("p", "user_TEST");
    const obj = a.objects.get("p");
    expect(obj?.tombstoned).toBe(true);
    expect(obj?.metadata.tombstoned_by).toBe("user_TEST");
    expect(obj?.body.toString()).toBe("x");
  });

  it("signedUrl is memory:// for testing visibility", async () => {
    const a = new MemoryBlobAdapter();
    const url = await a.signedUrl("p", { expiresInSeconds: 60 });
    expect(url.startsWith("memory://p?expires=")).toBe(true);
  });

  it("healthcheck returns true", async () => {
    expect(await new MemoryBlobAdapter().healthcheck()).toBe(true);
  });
});

describe("createBlobAdapter factory", () => {
  it("memory backend returns MemoryBlobAdapter", () => {
    const a = createBlobAdapter({ backend: "memory", container: "unused" });
    expect(a).toBeInstanceOf(MemoryBlobAdapter);
  });

  it("azure backend requires accountName + accountKey", () => {
    expect(() => createBlobAdapter({ backend: "azure", container: "c" })).toThrow(
      /azureAccountName/,
    );
  });

  it("s3 backend constructs without required extras", () => {
    const a = createBlobAdapter({ backend: "s3", container: "bkt", s3Region: "us-east-1" });
    expect(a).toBeDefined();
  });
});
