/**
 * /forgot-password's outbound sender.
 *
 * Reuses HttpEmailClient (@brain/surfaces) -- the same transport
 * services/api's onboarding/email-delivery.ts already uses -- rather than
 * forking a second one; only the message body (a set-password URL) differs.
 *
 * Prod currently has ZERO EMAIL_* keys configured. This fails loudly and
 * legibly at BOOT (a clear thrown Error, caught in main.ts and turned into a
 * console.error + exit(1), mirroring the existing AUTH_SIGN_KEY /
 * AUTH_COOKIE_SECRET boot checks) rather than silently no-op'ing at send
 * time. It never returns the token in an HTTP response -- that would be a
 * takeover primitive.
 */

import { HttpEmailClient, type HttpEmailClientOptions } from "@brain/surfaces";

export interface ForgotPasswordEmailConfig {
  readonly emailEndpoint: string | undefined;
  readonly emailApiKey: string | undefined;
  readonly emailFrom?: string | undefined;
  /** AUTH_ISSUER, e.g. https://auth.brain.fi -- this service's own origin. */
  readonly authIssuer: string;
  readonly fetchImpl?: HttpEmailClientOptions["fetchImpl"];
}

export interface ForgotPasswordEmailInput {
  readonly tenantId: string;
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export type ForgotPasswordEmailDelivery = (input: ForgotPasswordEmailInput) => Promise<boolean>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Throws when EMAIL_ENDPOINT / EMAIL_API_KEY are absent -- see file header. */
export function buildForgotPasswordEmailDelivery(
  config: ForgotPasswordEmailConfig,
): ForgotPasswordEmailDelivery {
  if (config.emailEndpoint === undefined || config.emailApiKey === undefined) {
    throw new Error(
      "[auth] EMAIL_ENDPOINT and EMAIL_API_KEY are required to serve POST /forgot-password " +
        "(the AS must be able to send a set-password link).",
    );
  }
  const client = new HttpEmailClient({
    endpoint: config.emailEndpoint,
    apiKey: config.emailApiKey,
    ...(config.emailFrom !== undefined ? { from: config.emailFrom } : {}),
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  });
  const authIssuer = config.authIssuer.replace(/\/+$/, "");

  return async ({ tenantId, email, token, expiresAt }) => {
    const link = `${authIssuer}/set-password?tid=${encodeURIComponent(tenantId)}&t=${encodeURIComponent(token)}`;
    const result = await client.send({
      tenantId,
      to: email,
      subject: "Reset your Brain account password",
      text: [
        "Use this link to set a new password for your Brain account:",
        "",
        link,
        "",
        `This link expires at ${expiresAt.toISOString()}. If you did not request this, ignore this email.`,
      ].join("\n"),
      html: [
        "<p>Use this link to set a new password for your Brain account:</p>",
        `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
        `<p>This link expires at ${escapeHtml(expiresAt.toISOString())}. If you did not request this, ignore this email.</p>`,
      ].join(""),
    });
    // Caller (POST /forgot-password) returns the SAME 202 to the browser
    // regardless -- anti-enumeration is non-negotiable -- but the boolean lets
    // it log a visible server-side warning rather than swallowing the failure.
    return result.ok;
  };
}
