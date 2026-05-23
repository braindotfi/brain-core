import { createHash } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { isBrainError } from "../errors.js";
import { verifyPlaidWebhook } from "./plaid.js";

async function makeSignedWebhook(
  rawBody: Buffer,
  overrides: { iat?: number; iss?: string } = {},
): Promise<{
  header: string;
  jwk: JWK;
  kid: string;
}> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const kid = "plaid-kid-test";
  const iat = overrides.iat ?? Math.floor(Date.now() / 1000);

  let builder = new SignJWT({ request_body_sha256: bodyHash })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuedAt(iat);
  if (overrides.iss !== undefined) builder = builder.setIssuer(overrides.iss);
  const header = await builder.sign(privateKey);

  const jwk = await exportJWK(publicKey);
  return { header, jwk: { ...jwk, kid }, kid };
}

describe("verifyPlaidWebhook", () => {
  it("accepts a valid signature with matching body hash", async () => {
    const body = Buffer.from(`{"webhook_code":"TRANSACTIONS:DEFAULT_UPDATE"}`);
    const { header, jwk } = await makeSignedWebhook(body);
    await expect(
      verifyPlaidWebhook(body, header, { keyResolver: async () => jwk }),
    ).resolves.toBeUndefined();
  });

  it("throws when body hash does not match (tamper detection)", async () => {
    const body = Buffer.from(`{"amount":100}`);
    const { header, jwk } = await makeSignedWebhook(body);
    const tampered = Buffer.from(`{"amount":200}`);
    try {
      await verifyPlaidWebhook(tampered, header, { keyResolver: async () => jwk });
      expect.fail("expected throw");
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
      if (isBrainError(err)) expect(err.code).toBe("raw_webhook_signature_invalid");
    }
  });

  it("rejects malformed header (not three dot-separated parts)", async () => {
    try {
      await verifyPlaidWebhook(Buffer.alloc(0), "not.a.jwt.actually.has.four.dots", {
        keyResolver: async () => ({}) as JWK,
      });
      expect.fail();
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
    }
  });

  it("rejects unsupported algorithms", async () => {
    const badHeader = [
      Buffer.from(JSON.stringify({ alg: "HS256", kid: "x" })).toString("base64url"),
      "e30", // {}
      "sig",
    ].join(".");
    try {
      await verifyPlaidWebhook(Buffer.alloc(0), badHeader, {
        keyResolver: async () => ({}) as JWK,
      });
      expect.fail();
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
    }
  });

  it("rejects a token whose issuer differs from expectedIssuer", async () => {
    const body = Buffer.from(`{"webhook_code":"TRANSACTIONS:DEFAULT_UPDATE"}`);
    const { header, jwk } = await makeSignedWebhook(body); // no iss claim
    await expect(
      verifyPlaidWebhook(body, header, {
        keyResolver: async () => jwk,
        expectedIssuer: "https://production.plaid.com",
      }),
    ).rejects.toSatisfy((err) => isBrainError(err) && err.code === "raw_webhook_signature_invalid");
  });

  it("accepts a token whose issuer matches expectedIssuer", async () => {
    const body = Buffer.from(`{"webhook_code":"X"}`);
    const { header, jwk } = await makeSignedWebhook(body, {
      iss: "https://production.plaid.com",
    });
    await expect(
      verifyPlaidWebhook(body, header, {
        keyResolver: async () => jwk,
        expectedIssuer: "https://production.plaid.com",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects when request_body_sha256 claim is missing", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k" } as JWK;
    const header = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "k" })
      .sign(privateKey);
    try {
      await verifyPlaidWebhook(Buffer.alloc(0), header, { keyResolver: async () => jwk });
      expect.fail();
    } catch (err) {
      expect(isBrainError(err)).toBe(true);
    }
  });
});
