import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * General-purpose signed, expiring, single-use-friendly token.
 *
 * The same `v1.<base64url envelope>.<base64url hmac>` construction (version
 * prefix, a random nonce, an `exp` claim, `timingSafeEqual` verification) was
 * implemented twice independently: `services/surface-gateway/src/slack-oauth.ts`
 * (Slack install state) and `packages/surfaces/src/surfaces/email/token.ts`
 * (email approval and recipient-verification links). Phase 2a of the OAuth
 * authorization server needs the same shape again (AS session cookie,
 * pending-authorization blob, CSRF token), so this is the one shared copy new
 * callers should use.
 *
 * Domain separation: `aud` is folded into the envelope and checked on verify,
 * so a token minted for one purpose (e.g. "auth.session") cannot be replayed
 * against a verifier expecting a different purpose (e.g. "auth.csrf"), even
 * though both would otherwise share a secret.
 *
 * The two existing call sites are NOT refactored onto this: doing so would
 * change what bytes get signed (this envelope always carries `aud`, theirs
 * does not), which changes the token's wire format even though the parsing
 * algorithm is the same shape. See the report for the full reasoning.
 */

const TOKEN_VERSION = "v1";

export interface MintedHmacToken {
  /** `v1.<envelope>.<signature>`, safe to put in a cookie value or a URL. */
  token: string;
  /** Random per-mint nonce, exposed so a caller can use it as a CSRF value. */
  nonce: string;
  expiresAt: Date;
}

export type VerifyHmacTokenResult<T> =
  | { ok: true; payload: T; nonce: string }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" | "wrong_audience" };

interface HmacTokenEnvelope {
  aud: string;
  nonce: string;
  exp: number;
  payload: unknown;
}

export function mintHmacToken(input: {
  secret: string;
  /** Domain-separation tag, e.g. "auth.session" or "auth.csrf". */
  aud: string;
  payload: unknown;
  ttlSeconds: number;
  nowMs?: number | undefined;
}): MintedHmacToken {
  const nowMs = input.nowMs ?? Date.now();
  const exp = Math.floor(nowMs / 1000) + input.ttlSeconds;
  const nonce = randomBytes(16).toString("base64url");
  const envelope: HmacTokenEnvelope = { aud: input.aud, nonce, exp, payload: input.payload };
  const encoded = base64url(JSON.stringify(envelope));
  const signature = sign(`${TOKEN_VERSION}.${encoded}`, input.secret);
  return {
    token: `${TOKEN_VERSION}.${encoded}.${signature}`,
    nonce,
    expiresAt: new Date(exp * 1000),
  };
}

export function verifyHmacToken<T = unknown>(input: {
  token: string;
  secret: string;
  aud: string;
  nowMs?: number | undefined;
}): VerifyHmacTokenResult<T> {
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: "malformed" };
  const [version, encoded, signature] = parts as [string, string, string];

  // The version prefix is part of the signed bytes, not just a routing tag:
  // otherwise a future v2 sharing this secret and envelope layout could have
  // a v1 token resubmitted with its version byte swapped and still verify.
  const expected = sign(`${version}.${encoded}`, input.secret);
  if (!constantTimeEqual(signature, expected)) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isHmacTokenEnvelope(parsed)) return { ok: false, reason: "malformed" };
  if (parsed.aud !== input.aud) return { ok: false, reason: "wrong_audience" };

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (parsed.exp <= nowSeconds) return { ok: false, reason: "expired" };

  return { ok: true, payload: parsed.payload as T, nonce: parsed.nonce };
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isHmacTokenEnvelope(value: unknown): value is HmacTokenEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["aud"] === "string" &&
    typeof record["nonce"] === "string" &&
    typeof record["exp"] === "number"
  );
}
