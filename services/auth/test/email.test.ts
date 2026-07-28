import { describe, expect, it, vi } from "vitest";
import { buildForgotPasswordEmailDelivery } from "../src/email.js";

describe("buildForgotPasswordEmailDelivery", () => {
  it("fails loudly at boot when EMAIL_ENDPOINT / EMAIL_API_KEY are absent", () => {
    expect(() =>
      buildForgotPasswordEmailDelivery({
        emailEndpoint: undefined,
        emailApiKey: undefined,
        authIssuer: "https://auth.brain.fi",
      }),
    ).toThrow(/EMAIL_ENDPOINT and EMAIL_API_KEY are required/);
  });

  it("is fully testable without real credentials via an injected fetchImpl", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ messageId: "msg_1" })),
    );
    const deliver = buildForgotPasswordEmailDelivery({
      emailEndpoint: "https://esp.example.test/send",
      emailApiKey: "test-key",
      authIssuer: "https://auth.brain.fi",
      fetchImpl,
    });
    const sent = await deliver({
      tenantId: "tnt_01J0000000000000000000000Z",
      email: "founder@example.com",
      token: "raw-token",
      expiresAt: new Date("2026-07-09T00:00:00.000Z"),
    });
    expect(sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.subject).toBe("Reset your Brain account password");
    expect(body.text).toContain(
      "https://auth.brain.fi/set-password?tid=tnt_01J0000000000000000000000Z&t=raw-token",
    );
    // Never returns the token in the caller-visible response -- only inside
    // the outbound email body sent to the ESP, never echoed back here.
  });

  it("returns false (not a throw) on a non-ok ESP response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 }));
    const deliver = buildForgotPasswordEmailDelivery({
      emailEndpoint: "https://esp.example.test/send",
      emailApiKey: "test-key",
      authIssuer: "https://auth.brain.fi",
      fetchImpl,
    });
    const sent = await deliver({
      tenantId: "tnt_01J0000000000000000000000Z",
      email: "founder@example.com",
      token: "raw-token",
      expiresAt: new Date(),
    });
    expect(sent).toBe(false);
  });
});
