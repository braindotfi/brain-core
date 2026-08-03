import { JwtSigner, loadConfig, PostgresAuditEmitter } from "@brain/shared";
import { CachedOnchainScopeChecker } from "@brain/mcp";
import { buildAuthApp } from "./server.js";
import { assertValidIssuer } from "./issuer.js";
import { assertAuthDbReachable, buildAuthDbPools } from "./db.js";
import { ResolverUserCredentialReader } from "./credentials.js";
import { buildForgotPasswordEmailDelivery } from "./email.js";
import { createAuthOnchainScopeChecker } from "./onchain-scope-checker.js";
import type { OauthRouteDeps } from "./routes/oauth.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.AUTH_SIGN_KEY === undefined || cfg.AUTH_SIGN_KEY === "") {
    console.error(
      "[auth] AUTH_SIGN_KEY is required (the private signing JWK as a JSON string) " +
        "to publish /.well-known/jwks.json at the issuer origin.",
    );
    process.exit(1);
  }
  if (cfg.AUTH_COOKIE_SECRET === undefined || cfg.AUTH_COOKIE_SECRET === "") {
    console.error(
      "[auth] AUTH_COOKIE_SECRET is required (a plain HMAC secret, distinct from " +
        "AUTH_SIGN_KEY) to serve /login, /set-password, and /forgot-password.",
    );
    process.exit(1);
  }

  try {
    assertValidIssuer(cfg.AUTH_ISSUER);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  let humanAuth: Parameters<typeof buildAuthApp>[0]["humanAuth"];
  let oauthCore: OauthRouteDeps;
  try {
    const pools = buildAuthDbPools({
      nodeEnv: cfg.NODE_ENV,
      authDbUrl: cfg.BRAIN_AUTH_DB_URL,
      resolverDbUrl: cfg.BRAIN_RESOLVER_DB_URL,
      auditDbUrl: cfg.BRAIN_AUTH_AUDIT_DB_URL,
      databaseUrl: cfg.DATABASE_URL,
      serviceName: cfg.SERVICE_NAME,
      statementTimeoutMs: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    });
    await assertAuthDbReachable(pools, cfg.NODE_ENV);
    const { authPool, resolverPool, auditPool } = pools;
    const deliverForgotPasswordEmail = buildForgotPasswordEmailDelivery({
      emailEndpoint: cfg.EMAIL_ENDPOINT,
      emailApiKey: cfg.EMAIL_API_KEY,
      emailFrom: cfg.EMAIL_FROM,
      authIssuer: cfg.AUTH_ISSUER,
    });
    const audit = new PostgresAuditEmitter(auditPool);
    humanAuth = {
      authPool,
      credentialReader: new ResolverUserCredentialReader(resolverPool),
      cookieSecret: cfg.AUTH_COOKIE_SECRET,
      audit,
      deliverForgotPasswordEmail,
    };

    // Phase 2a increment 3: the OAuth core reuses the SAME two pools above
    // (db.ts's header) and the same AUTH_SIGN_KEY/AUTH_ISSUER/AUTH_AUDIENCE
    // triple every other Brain minting path uses (OAUTH-AS-PLAN.md section
    // 3b) -- one signer, not a parallel token stack.
    const signJwk = JSON.parse(cfg.AUTH_SIGN_KEY) as {
      kty: string;
      alg?: string;
      [k: string]: unknown;
    };
    const signer = new JwtSigner({
      issuer: cfg.AUTH_ISSUER,
      audience: cfg.AUTH_AUDIENCE,
      key: signJwk,
      algorithm: typeof signJwk.alg === "string" ? signJwk.alg : "RS256",
    });
    const onchain = new CachedOnchainScopeChecker(
      createAuthOnchainScopeChecker({
        contractAddress: cfg.MCP_AGENT_REGISTRY_ADDRESS as `0x${string}`,
        rpcUrl: cfg.BASE_RPC_URL ?? cfg.RPC_URL,
      }),
    );
    oauthCore = {
      authPool,
      resolverPool,
      cookieSecret: cfg.AUTH_COOKIE_SECRET,
      audit,
      signer,
      onchain,
      authAudience: cfg.AUTH_AUDIENCE,
      mcpPublicResourceUrl: cfg.MCP_PUBLIC_RESOURCE_URL,
    };
  } catch (error) {
    // BRAIN_AUTH_DB_URL / BRAIN_RESOLVER_DB_URL / BRAIN_AUTH_AUDIT_DB_URL
    // missing in production, or EMAIL_ENDPOINT/EMAIL_API_KEY missing --
    // both fail loudly at boot rather than serving /login with no way to
    // ever complete a flow (db.ts, email.ts).
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const app = await buildAuthApp({
    issuer: cfg.AUTH_ISSUER,
    signKey: cfg.AUTH_SIGN_KEY,
    serviceName: cfg.SERVICE_NAME,
    serviceVersion: cfg.SERVICE_VERSION,
    commit: process.env.GIT_SHA ?? "dev",
    humanAuth,
    oauthCore,
  });

  const close = async (): Promise<void> => {
    await app.close();
  };
  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  await app.listen({ host: "0.0.0.0", port: cfg.PORT });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
