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

/**
 * Shared HttpEmailClient construction. Extended by both the bare-code sender
 * below (self-serve signup's own verify-email flow) and
 * buildSetPasswordEmailDelivery (the AS's URL-carrying set-password invite) --
 * one transport, two message shapes, per AUTH-PATHS-PLAN.md section 2 ("Extend
 * or parameterize rather than forking a second sender").
 */
function buildEmailClient(config: {
  emailEndpoint: string;
  emailApiKey: string;
  emailFrom?: string | undefined;
  fetchImpl?: HttpEmailClientOptions["fetchImpl"];
}): HttpEmailClient {
  return new HttpEmailClient({
    endpoint: config.emailEndpoint,
    apiKey: config.emailApiKey,
    ...(config.emailFrom !== undefined ? { from: config.emailFrom } : {}),
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  });
}

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

  const client = buildEmailClient({
    emailEndpoint: config.emailEndpoint,
    emailApiKey: config.emailApiKey,
    emailFrom: config.emailFrom,
    fetchImpl: config.fetchImpl,
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

export interface SetPasswordEmailDeliveryConfig {
  emailEndpoint?: string | undefined;
  emailApiKey?: string | undefined;
  emailFrom?: string | undefined;
  /** `AUTH_ISSUER`, e.g. https://auth.brain.fi -- the AS origin the link points at. */
  authIssuer: string;
  fetchImpl?: HttpEmailClientOptions["fetchImpl"];
}

export type SetPasswordEmailDelivery = (input: VerificationEmailInput) => Promise<void>;

/**
 * The AS's set-password link needs a URL, not the bare code
 * buildVerificationEmailDelivery sends (AUTH-PATHS-PLAN.md section 2: "The
 * verification email must carry a URL, not the bare code it sends now").
 * Used by production-tenancy's POST /v1/tenants to invite a new founder.
 * Reuses HttpEmailClient (the same transport as buildVerificationEmailDelivery)
 * with a different message body -- not a second sender.
 *
 * Returns undefined (lenient, not a boot fence) when ESP credentials are
 * absent: production tenancy has no feature flag gating it off, unlike
 * self-serve signup, so a missing EMAIL_* pair here must not block
 * POST /v1/tenants -- see the "do not fail tenant creation" note at the call
 * site.
 */
export function buildSetPasswordEmailDelivery(
  config: SetPasswordEmailDeliveryConfig,
): SetPasswordEmailDelivery | undefined {
  if (config.emailEndpoint === undefined || config.emailApiKey === undefined) {
    return undefined;
  }

  const client = buildEmailClient({
    emailEndpoint: config.emailEndpoint,
    emailApiKey: config.emailApiKey,
    emailFrom: config.emailFrom,
    fetchImpl: config.fetchImpl,
  });
  const authIssuer = config.authIssuer.replace(/\/+$/, "");

  return async ({ tenantId, email, token, expiresAt }) => {
    const link = `${authIssuer}/set-password?tid=${encodeURIComponent(tenantId)}&t=${encodeURIComponent(token)}`;
    const result = await client.send({
      tenantId,
      to: email,
      subject: "Set your Brain account password",
      text: [
        "Set a password to finish setting up your Brain account:",
        "",
        link,
        "",
        `This link expires at ${expiresAt.toISOString()}.`,
      ].join("\n"),
      html: [
        "<p>Set a password to finish setting up your Brain account:</p>",
        `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
        `<p>This link expires at ${escapeHtml(expiresAt.toISOString())}.</p>`,
      ].join(""),
    });

    if (!result.ok) {
      throw brainError("dependency_unavailable", "set-password email delivery failed", {
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
