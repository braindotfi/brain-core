/**
 * Boot fence for the BFF service-token mint route (POST /v1/auth/service-token).
 *
 * The service-token route is the production counterpart to the demo-provision
 * fence: a trusted backend-for-frontend (e.g. the Brain Finance BFF) mints a
 * scoped JWT for a STABLE per-user tenant. It is powerful (it materialises a
 * tenant + an active payment agent and mints a propose-capable token), so it
 * carries the same two boot invariants as demo-provision-fence.ts:
 *
 *   - Auth: BRAIN_SERVICE_TOKEN_SECRET must be set; the route compares
 *     X-Service-Token-Auth against it via constant-time comparison.
 *   - Scopes: the minted JWT carries READ + PROPOSE only — never
 *     payment_intent:approve, payment_intent:execute, audit:admin, or
 *     policy:write.
 *   - Boot fence: in NODE_ENV=production, enabling the route requires an
 *     explicit operator attestation (BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED)
 *     that the stack is testnet ("prod" in the public-deploy sense, not
 *     mainnet money). Mirrors the BRAIN_DEMO_PROVISION_TESTNET_ATTESTED gate.
 *
 * Same altitude as the other boot fences. Factored out for unit testability.
 */

export interface ServiceTokenFenceInput {
  nodeEnv: string | undefined;
  /** cfg.BRAIN_SERVICE_TOKEN_ENABLED: true/false after Zod transform. */
  serviceTokenEnabled: boolean;
  /** cfg.BRAIN_SERVICE_TOKEN_SECRET: the shared header secret. */
  serviceTokenSecret: string | undefined;
  /** cfg.BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED: "true" / "false" string. */
  testnetAttested: "true" | "false";
}

/**
 * Two assertions:
 *
 *   A. When the route is enabled, BRAIN_SERVICE_TOKEN_SECRET MUST be set.
 *      Otherwise the route would mint scoped tokens to anyone who could reach
 *      the endpoint. This applies in every environment.
 *
 *   B. When the route is enabled AND NODE_ENV=production, the operator MUST set
 *      BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED="true". The fence refuses to start
 *      otherwise. Mirrors the demo-provision testnet-attest gate: "you can run
 *      this in production, but only after explicitly attesting that this stack
 *      is the right kind of production".
 */
export function assertServiceTokenFences(input: ServiceTokenFenceInput): void {
  if (!input.serviceTokenEnabled) return; // route never registers; nothing to check.

  if (input.serviceTokenSecret === undefined || input.serviceTokenSecret.length === 0) {
    throw new Error(
      "BRAIN_SERVICE_TOKEN_SECRET is required when BRAIN_SERVICE_TOKEN_ENABLED=true. " +
        "POST /v1/auth/service-token is skipAuth: true (it issues a JWT, the caller " +
        "doesn't have one yet); callers must send X-Service-Token-Auth equal to the " +
        "secret. Refusing to start so the orchestrator surfaces the misconfiguration.",
    );
  }

  if (input.nodeEnv === "production" && input.testnetAttested !== "true") {
    throw new Error(
      "BRAIN_SERVICE_TOKEN_ENABLED=true on NODE_ENV=production but " +
        'BRAIN_SERVICE_TOKEN_TESTNET_ATTESTED is not "true". The service-token ' +
        "route mints propose-capable tokens for per-user tenants; enabling " +
        "it in a live-money production environment is a footgun. Operators must " +
        'explicitly attest the stack is testnet by setting "true" (same posture as ' +
        "the demo-provision testnet gate). Refusing to start.",
    );
  }
}
