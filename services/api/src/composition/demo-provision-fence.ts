/**
 * Boot fence for the BrainSaaS Playground provisioning route (batch 10 C-1).
 *
 * /v1/demo/provision-run mints a JWT and seeds a demo tenant. The route is
 * powerful (it materialises a brand-new tenant + agent) and was previously
 * gated only by BRAIN_DEMO_PROVISION_ENABLED with skipAuth: true and a
 * generous scope set (execute + audit:admin + policy:write). Three problems:
 *
 *   1. Unauthenticated. Anyone reaching the endpoint could mint a token.
 *   2. The minted scopes were broad enough to execute payments end-to-end,
 *      not just propose them.
 *   3. No boot fence: a misconfigured production stack with the env flag set
 *      and a live rail wired would expose a working drain path.
 *
 * Batch 10 closes all three:
 *
 *   - Auth: BRAIN_DEMO_PROVISION_SECRET must be set; the route compares
 *     X-Demo-Provision-Auth against it via constant-time comparison.
 *   - Scopes: the minted JWT carries READ + PROPOSE only.
 *   - Boot fence: in NODE_ENV=production, enabling provisioning requires an
 *     explicit operator attestation (BRAIN_DEMO_PROVISION_TESTNET_ATTESTED)
 *     that the stack is testnet ("prod" in the sense of public deploy, but
 *     not mainnet money). Mirrors the BRAIN_ESCROW_AUDIT_APPROVED pattern.
 *
 * Same altitude as the other boot fences. Factored out for unit testability.
 */

export interface DemoProvisionFenceInput {
  nodeEnv: string | undefined;
  /** cfg.BRAIN_DEMO_PROVISION_ENABLED: true/false after Zod transform. */
  provisionEnabled: boolean;
  /** cfg.BRAIN_DEMO_PROVISION_SECRET: the shared header secret. */
  provisionSecret: string | undefined;
  /** cfg.BRAIN_DEMO_PROVISION_TESTNET_ATTESTED: "true" / "false" string. */
  testnetAttested: "true" | "false";
}

/**
 * Two assertions:
 *
 *   A. When provisioning is enabled, BRAIN_DEMO_PROVISION_SECRET MUST be set.
 *      Otherwise the route would mint tokens to anyone who could reach the
 *      endpoint. This applies in every environment.
 *
 *   B. When provisioning is enabled AND NODE_ENV=production, the operator
 *      MUST set BRAIN_DEMO_PROVISION_TESTNET_ATTESTED="true". The fence
 *      refuses to start otherwise. Mirrors the escrow-audit-gate pattern:
 *      "you can run this in production, but only after explicitly attesting
 *      that this stack is the right kind of production".
 */
export function assertDemoProvisionFences(input: DemoProvisionFenceInput): void {
  if (!input.provisionEnabled) return; // route never registers; nothing to check.

  if (input.provisionSecret === undefined || input.provisionSecret.length === 0) {
    throw new Error(
      "BRAIN_DEMO_PROVISION_SECRET is required when BRAIN_DEMO_PROVISION_ENABLED=true. " +
        "The provision-run route is no longer skipAuth: true; callers must send " +
        "X-Demo-Provision-Auth equal to the secret. Refusing to start so the " +
        "orchestrator surfaces the misconfiguration.",
    );
  }

  if (input.nodeEnv === "production" && input.testnetAttested !== "true") {
    throw new Error(
      "BRAIN_DEMO_PROVISION_ENABLED=true on NODE_ENV=production but " +
        'BRAIN_DEMO_PROVISION_TESTNET_ATTESTED is not "true". The provision-run ' +
        "route mints tenants and seeds money-touching demo data; enabling it in a " +
        "live-money production environment is a footgun. Operators must " +
        'explicitly attest the stack is testnet by setting "true" (same posture ' +
        "as the mainnet-escrow audit gate). Refusing to start.",
    );
  }
}
