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
 * Required env:
 *   AUTH_JWT_SECRET        HMAC-SHA256 secret (default: dev-secret-not-for-production)
 *
 * Optional env:
 *   AUTH_ISSUER            JWT iss claim (default: https://auth.brain.fi)
 *   AUTH_AUDIENCE          JWT aud claim (default: brain-api)
 *
 * Example:
 *   export BRAIN_TOKEN=$(pnpm run dev-token --tenant tnt_01GOLDEN00000000000000000 \
 *     --scopes 'execution:propose,execution:write,execution:read,execution:admin,wiki:read,raw:write,audit:read')
 */

import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";

const ALL_SCOPES = [
  "execution:propose",
  "execution:write",
  "execution:read",
  "execution:admin",
  "wiki:read",
  "wiki:write",
  "raw:write",
  "raw:read",
  "audit:read",
  "policy:read",
  "policy:write",
  "policy:admin",
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

  const secret = process.env["AUTH_JWT_SECRET"] ?? "dev-secret-not-for-production";
  const issuer = process.env["AUTH_ISSUER"] ?? "https://auth.brain.fi";
  const audience = process.env["AUTH_AUDIENCE"] ?? "brain-api";

  const key = new TextEncoder().encode(secret);

  const now = Math.floor(Date.now() / 1000);
  const jti = randomUUID();
  const token = await new SignJWT({
    sub: principalId,
    tenant_id: tenantId,
    principal_type: principalType,
    scopes,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setJti(jti)
    .sign(key);

  process.stdout.write(token + "\n");
}

main().catch((err: unknown) => {
  console.error("dev-token failed:", err);
  process.exit(1);
});
