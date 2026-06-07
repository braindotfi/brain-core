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

  it("purgeTenant deletes exactly the tenant's objects (GDPR erasure, R-02)", async () => {
    const a = new MemoryBlobAdapter();
    await a.put(blobPath("tnt_a", "s1", new Date("2026-01-01T00:00:00Z")), Buffer.from("1"), {});
    await a.put(blobPath("tnt_a", "s2", new Date("2026-02-01T00:00:00Z")), Buffer.from("2"), {});
    await a.put(blobPath("tnt_b", "s3", new Date("2026-01-01T00:00:00Z")), Buffer.from("3"), {});

    const res = await a.purgeTenant("tnt_a");

    expect(res).toEqual({ deleted: 2, failures: [] });
    // tnt_a is gone, tnt_b untouched (no cross-tenant erasure).
    expect([...a.objects.keys()].some((k) => k.startsWith("tnt_a/"))).toBe(false);
    expect([...a.objects.keys()].some((k) => k.startsWith("tnt_b/"))).toBe(true);
  });

  it("purgeTenant is idempotent and a no-op for an unknown tenant", async () => {
    const a = new MemoryBlobAdapter();
    await a.put(blobPath("tnt_a", "s1"), Buffer.from("1"), {});
    expect((await a.purgeTenant("tnt_a")).deleted).toBe(1);
    // second run finds nothing left
    expect(await a.purgeTenant("tnt_a")).toEqual({ deleted: 0, failures: [] });
    expect(await a.purgeTenant("tnt_missing")).toEqual({ deleted: 0, failures: [] });
  });

  it("purgeTenant does not match a tenant id that is a prefix of another", async () => {
    const a = new MemoryBlobAdapter();
    await a.put(blobPath("tnt_a", "s1"), Buffer.from("1"), {});
    await a.put(blobPath("tnt_ab", "s2"), Buffer.from("2"), {});
    const res = await a.purgeTenant("tnt_a");
    expect(res.deleted).toBe(1); // only tnt_a/, the trailing slash prevents tnt_ab/ matching
    expect([...a.objects.keys()].some((k) => k.startsWith("tnt_ab/"))).toBe(true);
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
