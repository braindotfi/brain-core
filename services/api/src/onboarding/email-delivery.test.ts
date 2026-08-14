import { describe, expect, it, vi } from "vitest";
import { buildVerificationEmailDelivery, buildSetPasswordEmailDelivery } from "./email-delivery.js";

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

  it("keeps the client-facing detail generic but attaches the provider's raw rejection as cause", async () => {
    // The provider's real reason (e.g. "sender identity not verified") must
    // reach server-side logs via cause, without changing what a public,
    // unauthenticated POST /v1/signup caller sees in details.provider_error.
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "sender identity not verified" }] }), {
          status: 422,
          statusText: "Unprocessable Entity",
        }),
    );
    const deliverVerificationEmail = buildVerificationEmailDelivery({
      selfServeSignupEnabled: true,
      exposeVerificationToken: false,
      emailEndpoint: "https://esp.example.test/send",
      emailApiKey: "test-api-key",
      fetchImpl,
    });

    const attempt = deliverVerificationEmail?.({
      tenantId: "tnt_01J0000000000000000000000Z",
      userId: "user_01J0000000000000000000000A",
      email: "founder@example.com",
      token: "verify-token-123",
      expiresAt: new Date("2026-07-09T00:00:00.000Z"),
    });

    await expect(attempt).rejects.toMatchObject({
      code: "dependency_unavailable",
      details: { provider_error: "Unprocessable Entity" },
      cause: expect.objectContaining({
        message: expect.stringContaining("sender identity not verified"),
      }),
    });
  });
});

describe("buildSetPasswordEmailDelivery", () => {
  it("returns undefined when ESP credentials are absent (lenient, not a boot fence)", () => {
    expect(buildSetPasswordEmailDelivery({ authIssuer: "https://auth.brain.fi" })).toBeUndefined();
  });

  it("sends a set-password URL, not a bare code, through the shared HTTP email client", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ messageId: "msg_123" })),
    );
    const deliver = buildSetPasswordEmailDelivery({
      emailEndpoint: "https://esp.example.test/send",
      emailApiKey: "test-api-key",
      emailFrom: "invite@brain.fi",
      authIssuer: "https://auth.brain.fi/",
      fetchImpl,
    });

    expect(deliver).toBeDefined();
    await deliver?.({
      tenantId: "tnt_01J0000000000000000000000Z",
      userId: "user_01J0000000000000000000000A",
      email: "founder@example.com",
      token: "raw-token-abc",
      expiresAt: new Date("2026-07-09T00:00:00.000Z"),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected email provider call");
    const [, init] = firstCall;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.subject).toBe("Set your Brain account password");
    const expectedLink =
      "https://auth.brain.fi/set-password?tid=tnt_01J0000000000000000000000Z&t=raw-token-abc";
    expect(body.text).toContain(expectedLink);
    expect(body.html).toContain(expectedLink.replaceAll("&", "&amp;"));
    // The old bare-code sender's message never appears here.
    expect(body.text).not.toContain("verification token");
  });

  it("propagates a non-ok ESP response as dependency_unavailable, with the raw body as cause", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 }));
    const deliver = buildSetPasswordEmailDelivery({
      emailEndpoint: "https://esp.example.test/send",
      emailApiKey: "test-api-key",
      authIssuer: "https://auth.brain.fi",
      fetchImpl,
    });
    await expect(
      deliver?.({
        tenantId: "tnt_01J0000000000000000000000Z",
        userId: "user_01J0000000000000000000000A",
        email: "founder@example.com",
        token: "raw-token-abc",
        expiresAt: new Date(),
      }),
    ).rejects.toMatchObject({
      code: "dependency_unavailable",
      cause: expect.objectContaining({ message: expect.stringContaining("nope") }),
    });
  });
});
