import { describe, expect, it } from "vitest";
import { isPublicUrl, publicOnlyLookup } from "./ssrf.js";

describe("isPublicUrl — SSRF guard", () => {
  it("blocks the cloud metadata / link-local address", async () => {
    expect(await isPublicUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("blocks loopback (IPv4 and IPv6)", async () => {
    expect(await isPublicUrl("https://127.0.0.1/")).toBe(false);
    expect(await isPublicUrl("https://[::1]/")).toBe(false);
    expect(await isPublicUrl("https://localhost/")).toBe(false); // resolves to loopback
  });

  it("blocks RFC1918 private ranges", async () => {
    expect(await isPublicUrl("https://10.0.0.5/")).toBe(false);
    expect(await isPublicUrl("https://192.168.1.1/")).toBe(false);
    expect(await isPublicUrl("https://172.16.0.9/")).toBe(false);
  });

  it("blocks unspecified, CGNAT, and IPv4-mapped loopback", async () => {
    expect(await isPublicUrl("https://0.0.0.0/")).toBe(false);
    expect(await isPublicUrl("https://100.64.0.1/")).toBe(false);
    expect(await isPublicUrl("https://[::ffff:127.0.0.1]/")).toBe(false);
  });

  it("blocks non-allowed protocols and embedded credentials", async () => {
    expect(await isPublicUrl("http://8.8.8.8/")).toBe(false); // default allows https only
    expect(await isPublicUrl("ftp://8.8.8.8/")).toBe(false);
    expect(await isPublicUrl("https://user:pass@8.8.8.8/")).toBe(false);
    expect(await isPublicUrl("not a url")).toBe(false);
  });

  it("allows public addresses", async () => {
    expect(await isPublicUrl("https://8.8.8.8/path")).toBe(true);
    expect(await isPublicUrl("https://1.1.1.1/")).toBe(true);
  });

  it("honors allowedProtocols", async () => {
    expect(await isPublicUrl("http://8.8.8.8/", { allowedProtocols: ["http:", "https:"] })).toBe(
      true,
    );
    expect(await isPublicUrl("http://10.0.0.1/", { allowedProtocols: ["http:", "https:"] })).toBe(
      false,
    );
  });
});

describe("publicOnlyLookup — DNS-rebinding socket pin", () => {
  function resolve(host: string): Promise<{ err: NodeJS.ErrnoException | null; address: string }> {
    return new Promise((done) => {
      publicOnlyLookup(host, {}, (err, address) => done({ err, address }));
    });
  }

  it("errors (ESSRFBLOCKED) when the host resolves only to a blocked address", async () => {
    const { err } = await resolve("localhost"); // → 127.0.0.1 / ::1
    expect(err).not.toBeNull();
    expect(err?.code).toBe("ESSRFBLOCKED");
  });

  it("resolves a public IP literal unchanged", async () => {
    const { err, address } = await resolve("8.8.8.8");
    expect(err).toBeNull();
    expect(address).toBe("8.8.8.8");
  });
});
