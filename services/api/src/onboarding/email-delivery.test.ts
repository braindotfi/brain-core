import { describe, expect, it, vi } from "vitest";
import { buildVerificationEmailDelivery } from "./email-delivery.js";

describe("buildVerificationEmailDelivery", () => {
  it("fails boot when signup hides tokens and no ESP credentials are configured", () => {
    expect(() =>
      buildVerificationEmailDelivery({
        selfServeSignupEnabled: true,
        exposeVerificationToken: false,
      }),
    ).toThrow(/BRAIN_SELF_SERVE_SIGNUP=true.*EMAIL_ENDPOINT.*EMAIL_API_KEY/);
  });

  it("does not require ESP credentials when signup is disabled", () => {
    expect(
      buildVerificationEmailDelivery({
        selfServeSignupEnabled: false,
        exposeVerificationToken: false,
      }),
    ).toBeUndefined();
  });

  it("does not require ESP credentials when raw tokens are exposed outside production", () => {
    expect(
      buildVerificationEmailDelivery({
        selfServeSignupEnabled: true,
        exposeVerificationToken: true,
      }),
    ).toBeUndefined();
  });

  it("sends the verification token through the shared HTTP email client", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ messageId: "msg_123" })),
    );
    const deliverVerificationEmail = buildVerificationEmailDelivery({
      selfServeSignupEnabled: true,
      exposeVerificationToken: false,
      emailEndpoint: "https://esp.example.test/send",
      emailApiKey: "test-api-key",
      emailFrom: "verify@brain.fi",
      fetchImpl,
    });

    expect(deliverVerificationEmail).toBeDefined();
    await deliverVerificationEmail?.({
      tenantId: "tnt_01J0000000000000000000000Z",
      userId: "user_01J0000000000000000000000A",
      email: "founder@example.com",
      token: "verify-token-123",
      expiresAt: new Date("2026-07-09T00:00:00.000Z"),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected email provider call");
    const [url, init] = firstCall;
    expect(String(url)).toBe("https://esp.example.test/send");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer test-api-key",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: "verify@brain.fi",
      to: "founder@example.com",
      subject: "Verify your Brain account",
    });
    expect(body.text).toContain("verify-token-123");
    expect(body.html).toContain("verify-token-123");
  });
});
