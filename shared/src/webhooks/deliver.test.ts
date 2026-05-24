import { describe, expect, it } from "vitest";
import { deliverWebhook } from "./outbound.js";

describe("deliverWebhook SSRF guard", () => {
  it("refuses a loopback target without making a request", async () => {
    const r = await deliverWebhook({ url: "http://127.0.0.1/hook", secret: "s" }, "{}");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a public address/);
  });

  it("refuses a private RFC-1918 target", async () => {
    const r = await deliverWebhook({ url: "http://10.0.0.5/hook", secret: "s" }, "{}");
    expect(r.ok).toBe(false);
  });

  it("refuses a non-http(s) scheme", async () => {
    const r = await deliverWebhook({ url: "file:///etc/passwd", secret: "s" }, "{}");
    expect(r.ok).toBe(false);
  });
});
