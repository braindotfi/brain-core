/**
 * static-jwks — a tiny JWKS endpoint for the testnet/single-VM deploy.
 *
 * Production verifies bearer JWTs by fetching a JWKS (`AUTH_JWKS_URL` →
 * createRemoteJWKSet). This sidecar publishes the PUBLIC half of the same key
 * the API/SIWX path signs with (`AUTH_SIGN_KEY`, a private JWK JSON string), so
 * one secret drives both signing and verification without an external IdP.
 *
 *   AUTH_SIGN_KEY   private signing JWK (JSON). Required. NEVER published — only
 *                   its public projection (toPublicJwk) is served.
 *   PORT            listen port (default 8085).
 *
 * Mint test tokens against this key with `tools/dev-token` (set AUTH_SIGN_KEY).
 * Generate a fresh key with `pnpm --filter @brain/static-jwks run generate`.
 */

import { createServer } from "node:http";
import { jwksFromPrivate } from "@brain/shared";

function loadJwksBody(signKey: string): { body: string; kid: string } {
  const jwk = JSON.parse(signKey) as Parameters<typeof jwksFromPrivate>[0];
  const jwks = jwksFromPrivate(jwk);
  return { body: JSON.stringify(jwks), kid: jwks.keys[0]?.kid ?? "(none)" };
}

function main(): void {
  const port = Number(process.env["PORT"] ?? "8085");
  const signKey = process.env["AUTH_SIGN_KEY"];
  if (signKey === undefined || signKey === "") {
    console.error(
      "[static-jwks] AUTH_SIGN_KEY is required (the private signing JWK as a JSON string). " +
        "Generate one with: pnpm --filter @brain/static-jwks run generate",
    );
    process.exit(1);
  }

  // Throws on a malformed/symmetric key — surfaced by main().catch as a crash,
  // which is the correct fail-closed behaviour (better than serving no key).
  const { body, kid } = loadJwksBody(signKey);

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method === "GET" && req.url === "/.well-known/jwks.json") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not_found"}');
  });

  server.listen(port, () => {
    console.log(`[static-jwks] publishing /.well-known/jwks.json on :${port} (kid=${kid})`);
  });
}

main();
