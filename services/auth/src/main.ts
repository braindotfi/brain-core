import { loadConfig } from "@brain/shared";
import { buildAuthApp } from "./server.js";
import { assertValidIssuer } from "./issuer.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.AUTH_SIGN_KEY === undefined || cfg.AUTH_SIGN_KEY === "") {
    console.error(
      "[auth] AUTH_SIGN_KEY is required (the private signing JWK as a JSON string) " +
        "to publish /.well-known/jwks.json at the issuer origin.",
    );
    process.exit(1);
  }

  try {
    assertValidIssuer(cfg.AUTH_ISSUER);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const app = await buildAuthApp({
    issuer: cfg.AUTH_ISSUER,
    signKey: cfg.AUTH_SIGN_KEY,
    serviceName: cfg.SERVICE_NAME,
    serviceVersion: cfg.SERVICE_VERSION,
    commit: process.env.GIT_SHA ?? "dev",
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
