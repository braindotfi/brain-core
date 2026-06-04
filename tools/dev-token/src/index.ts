/**
 * dev-token — mint a short-lived Brain JWT for local API testing.
 *
 * Usage:
 *   pnpm run dev-token [options]
 *
 * Options:
 *   --tenant <id>          Tenant ID (required)
 *   --principal <id>       Principal ID (default: usr_dev)
 *   --principal-type <t>   user | agent (default: user)
 *   --scopes <csv>         Comma-separated scopes (default: all scopes)
 *   --ttl <seconds>        Token lifetime in seconds (default: 3600)
 *
 * Signing key (one of):
 *   AUTH_SIGN_KEY          Private signing JWK (JSON) → mints an RS256 token the
 *                          production JWKS verifier accepts (same key the
 *                          static-jwks sidecar publishes). Preferred for prod.
 *   AUTH_JWT_SECRET        HMAC-SHA256 secret (default: dev-secret-not-for-production).
 *                          HS256 fallback — only valid against a non-prod verifier.
 *
 * Optional env:
 *   AUTH_ISSUER            JWT iss claim (default: https://auth.brain.fi)
 *   AUTH_AUDIENCE          JWT aud claim (default: brain-api)
 *
 * Example:
 *   export BRAIN_TOKEN=$(pnpm run dev-token --tenant tnt_01GOLDEN00000000000000000 \
 *     --scopes 'execution:propose,execution:write,execution:read,execution:admin,wiki:read,raw:write,audit:read')
 */

import { SignJWT, importJWK, type JWK } from "jose";
import { randomUUID } from "node:crypto";

// Mirror the full VALID_SCOPES set (shared/src/auth/scopes.ts) so the default
// token can exercise every surface — notably ledger:* and payment_intent:*,
// which the money path requires and which were previously missing here.
const ALL_SCOPES = [
  "execution:propose",
  "execution:write",
  "execution:read",
  "execution:admin",
  "payment_intent:propose",
  "payment_intent:approve",
  "payment_intent:execute",
  "ledger:read",
  "ledger:write",
  "ledger:admin",
  "wiki:read",
  "wiki:write",
  "wiki:admin",
  "raw:read",
  "raw:write",
  "raw:admin",
  "audit:read",
  "audit:write",
  "audit:admin",
  "policy:read",
  "policy:write",
  "policy:admin",
  "policy:sign",
];

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        args[key] = val;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const tenantId = args["tenant"];
  if (!tenantId) {
    console.error("--tenant is required");
    process.exit(1);
  }

  const principalId = args["principal"] ?? "usr_dev";
  const principalType = (args["principal-type"] ?? "user") as "user" | "agent";
  const scopesArg = args["scopes"];
  const scopes = scopesArg ? scopesArg.split(",").map((s) => s.trim()) : ALL_SCOPES;
  const ttl = parseInt(args["ttl"] ?? "3600", 10);

  const issuer = process.env["AUTH_ISSUER"] ?? "https://auth.brain.fi";
  const audience = process.env["AUTH_AUDIENCE"] ?? "brain-api";

  // Production verifies via JWKS (RS256). When AUTH_SIGN_KEY (a private JWK JSON
  // string — the same key the static-jwks sidecar publishes) is set, mint an
  // RS256 token the production verifier accepts. Otherwise fall back to the
  // HS256 dev secret (only valid against a non-production verifier).
  const signKeyJson = process.env["AUTH_SIGN_KEY"];
  let signer: Parameters<SignJWT["sign"]>[0];
  let header: { alg: string; kid?: string };
  if (signKeyJson !== undefined && signKeyJson !== "") {
    const jwk = JSON.parse(signKeyJson) as JWK;
    const alg = jwk.alg ?? "RS256";
    signer = await importJWK(jwk, alg);
    header = jwk.kid !== undefined ? { alg, kid: jwk.kid } : { alg };
  } else {
    const secret = process.env["AUTH_JWT_SECRET"] ?? "dev-secret-not-for-production";
    signer = new TextEncoder().encode(secret);
    header = { alg: "HS256" };
  }

  const now = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const token = await new SignJWT({
    sub: principalId,
    tenant_id: tenantId,
    principal_type: principalType,
    scopes,
  })
    .setProtectedHeader(header)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(jti)
    .sign(signer);

  process.stdout.write(token + "\n");
}

main().catch((err: unknown) => {
  console.error("dev-token failed:", err);
  process.exit(1);
});
