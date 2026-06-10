/**
 * Stripe webhook signature verification.
 *
 * Stripe signs webhook deliveries with an endpoint signing secret
 * (`whsec_...`): the `Stripe-Signature` header carries
 * `t=<unix-seconds>,v1=<hex hmac>[,v1=<hex hmac>...]` where each v1 is
 * HMAC-SHA256(secret, `${t}.${rawBody}`). Multiple v1 entries appear during
 * secret rotation; verification passes when ANY matches (constant-time
 * comparison per candidate). The timestamp is bounded by a tolerance window
 * to stop replay of captured deliveries.
 *
 * Mirrors the Plaid verifier's contract: throws
 * BrainError("raw_webhook_signature_invalid") on any failure, returns
 * silently on success. Pure given (body, header, opts); `now` is injectable
 * for tests.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { brainError } from "../errors.js";

export interface StripeVerifyOptions {
  /** Endpoint signing secret (whsec_...). */
  signingSecret: string;
  /** Allowed |now - t| skew in seconds. Default 300 (Stripe's recommendation). */
  clockToleranceSeconds?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function verifyStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  opts: StripeVerifyOptions,
): void {
  if (signatureHeader === undefined || signatureHeader.length === 0) {
    throw brainError("raw_webhook_signature_invalid", "missing Stripe-Signature header");
  }

  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      candidates.push(value);
    }
  }

  if (timestamp === null || candidates.length === 0) {
    throw brainError(
      "raw_webhook_signature_invalid",
      "malformed Stripe-Signature header (expected t=...,v1=...)",
    );
  }

  const tolerance = opts.clockToleranceSeconds ?? 300;
  const nowSeconds = Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    throw brainError(
      "raw_webhook_signature_invalid",
      "Stripe-Signature timestamp outside tolerance",
      {
        details: { timestamp, tolerance_seconds: tolerance },
      },
    );
  }

  const expected = createHmac("sha256", opts.signingSecret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();

  const matches = candidates.some((candidate) => {
    let provided: Buffer;
    try {
      provided = Buffer.from(candidate, "hex");
    } catch {
      return false;
    }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!matches) {
    throw brainError("raw_webhook_signature_invalid", "Stripe-Signature did not verify");
  }
}
