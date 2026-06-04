/**
 * static-jwks generate — mint a fresh signing key for AUTH_SIGN_KEY.
 *
 *   pnpm --filter @brain/static-jwks run generate [alg]   # alg defaults to RS256
 *
 * Prints the private JWK to set as AUTH_SIGN_KEY (in .env.prod — keep secret)
 * and the public JWKS the sidecar will serve. The same AUTH_SIGN_KEY drives the
 * SIWX signer, the static-jwks sidecar, and tools/dev-token.
 */

import { generateSignKeyJwk, jwksFromPrivate } from "@brain/shared";

async function main(): Promise<void> {
  const alg = process.argv[2] ?? "RS256";
  const priv = await generateSignKeyJwk(alg);
  const pub = jwksFromPrivate(priv);
  process.stdout.write(
    [
      "# --- AUTH_SIGN_KEY (PRIVATE — set in .env.prod, keep secret) ---",
      `AUTH_SIGN_KEY=${JSON.stringify(priv)}`,
      "",
      `# kid: ${priv.kid ?? "(none)"}   alg: ${priv.alg ?? alg}`,
      "# Public JWKS the sidecar serves at /.well-known/jwks.json:",
      JSON.stringify(pub, null, 2),
      "",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  console.error("static-jwks generate failed:", err);
  process.exit(1);
});
