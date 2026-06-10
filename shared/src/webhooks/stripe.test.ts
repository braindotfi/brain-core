import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeWebhook } from "./stripe.js";

const SECRET = "whsec_test_secret";
const BODY = Buffer.from(JSON.stringify({ id: "evt_1", type: "charge.succeeded" }));
const NOW = new Date("2026-06-11T00:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function sign(body: Buffer, timestamp: number, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

const OPTS = { signingSecret: SECRET, now: () => NOW };

describe("verifyStripeWebhook", () => {
  it("accepts a valid t=,v1= signature", () => {
    const header = `t=${NOW_S},v1=${sign(BODY, NOW_S)}`;
    expect(() => verifyStripeWebhook(BODY, header, OPTS)).not.toThrow();
  });

  it("accepts when any v1 candidate matches (secret rotation)", () => {
    const header = `t=${NOW_S},v1=${"0".repeat(64)},v1=${sign(BODY, NOW_S)}`;
    expect(() => verifyStripeWebhook(BODY, header, OPTS)).not.toThrow();
  });

  it("rejects a signature minted with the wrong secret", () => {
    const header = `t=${NOW_S},v1=${sign(BODY, NOW_S, "whsec_other")}`;
    expect(() => verifyStripeWebhook(BODY, header, OPTS)).toThrow(/did not verify/);
  });

  it("rejects a tampered body", () => {
    const header = `t=${NOW_S},v1=${sign(BODY, NOW_S)}`;
    expect(() => verifyStripeWebhook(Buffer.from("{tampered}"), header, OPTS)).toThrow(
      /did not verify/,
    );
  });

  it("rejects a stale timestamp (replay window)", () => {
    const stale = NOW_S - 301;
    const header = `t=${stale},v1=${sign(BODY, stale)}`;
    expect(() => verifyStripeWebhook(BODY, header, OPTS)).toThrow(/outside tolerance/);
  });

  it("honors a custom tolerance", () => {
    const old = NOW_S - 400;
    const header = `t=${old},v1=${sign(BODY, old)}`;
    expect(() =>
      verifyStripeWebhook(BODY, header, { ...OPTS, clockToleranceSeconds: 600 }),
    ).not.toThrow();
  });

  it("rejects a missing header", () => {
    expect(() => verifyStripeWebhook(BODY, undefined, OPTS)).toThrow(/missing Stripe-Signature/);
  });

  it("rejects a malformed header", () => {
    expect(() => verifyStripeWebhook(BODY, "v1=abc", OPTS)).toThrow(/malformed/);
    expect(() => verifyStripeWebhook(BODY, `t=${NOW_S}`, OPTS)).toThrow(/malformed/);
    expect(() => verifyStripeWebhook(BODY, "nonsense", OPTS)).toThrow(/malformed/);
  });
});
