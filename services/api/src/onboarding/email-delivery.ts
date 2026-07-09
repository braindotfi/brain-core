import { HttpEmailClient, type HttpEmailClientOptions } from "@brain/surfaces";
import { brainError } from "@brain/shared";

export interface VerificationEmailDeliveryConfig {
  selfServeSignupEnabled: boolean;
  exposeVerificationToken: boolean;
  emailEndpoint?: string | undefined;
  emailApiKey?: string | undefined;
  emailFrom?: string | undefined;
  fetchImpl?: HttpEmailClientOptions["fetchImpl"];
}

export interface VerificationEmailInput {
  tenantId: string;
  userId: string;
  email: string;
  token: string;
  expiresAt: Date;
}

export type VerificationEmailDelivery = (input: VerificationEmailInput) => Promise<void>;

export function buildVerificationEmailDelivery(
  config: VerificationEmailDeliveryConfig,
): VerificationEmailDelivery | undefined {
  if (!config.selfServeSignupEnabled || config.exposeVerificationToken) {
    return undefined;
  }

  if (config.emailEndpoint === undefined || config.emailApiKey === undefined) {
    throw new Error(
      "BRAIN_SELF_SERVE_SIGNUP=true with hidden verification tokens requires EMAIL_ENDPOINT and EMAIL_API_KEY",
    );
  }

  const client = new HttpEmailClient({
    endpoint: config.emailEndpoint,
    apiKey: config.emailApiKey,
    ...(config.emailFrom !== undefined ? { from: config.emailFrom } : {}),
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  });

  return async ({ tenantId, email, token, expiresAt }) => {
    const result = await client.send({
      tenantId,
      to: email,
      subject: "Verify your Brain account",
      text: [
        "Use this verification token to finish setting up your Brain account.",
        "",
        token,
        "",
        `This token expires at ${expiresAt.toISOString()}.`,
      ].join("\n"),
      html: [
        "<p>Use this verification token to finish setting up your Brain account.</p>",
        `<p><code>${escapeHtml(token)}</code></p>`,
        `<p>This token expires at ${escapeHtml(expiresAt.toISOString())}.</p>`,
      ].join(""),
    });

    if (!result.ok) {
      throw brainError("dependency_unavailable", "email verification delivery failed", {
        details: { provider_error: result.error ?? "email provider returned a non-success status" },
      });
    }
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
