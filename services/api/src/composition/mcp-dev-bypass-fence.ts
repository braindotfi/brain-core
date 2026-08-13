/**
 * Boot fence for BRAIN_MCP_DEV_AUTH_BYPASS (BRAIN-97).
 *
 * The bypass swaps the real McpAuthVerifier for FakeAuthVerifier, which
 * returns a hardcoded active agent for ANY principal -- no agents-table
 * lookup, no active check, no tenant-equality check, no on-chain gate. It
 * also disables skipPrincipalTypeCheck on the MCP route, so api_partner
 * tokens are accepted there too. This is a local-development convenience
 * only; it must never be reachable against a database that holds anything
 * other than throwaway local data.
 *
 * Old fence: rejected the flag only when NODE_ENV === "production". The
 * shared config enum (shared/src/config.ts) has a fourth value, "staging",
 * which is a real deployed environment with a real database and was never
 * covered -- an operator could set NODE_ENV=staging with the bypass on and
 * boot would succeed. This fence is an ALLOWLIST instead of a denylist: only
 * "development" and "test" may ever enable the bypass. Every other value,
 * including an unexpected or missing one, is refused.
 */

const MCP_DEV_BYPASS_ALLOWED_NODE_ENVS = ["development", "test"] as const;

/**
 * True only for the two node envs the dev-auth bypass may ever run in.
 * Both the boot fence below and the skipPrincipalTypeCheck wiring in
 * main.ts must use this SAME function, not two independently-written
 * conditions -- that duplication is exactly how skipPrincipalTypeCheck
 * ended up wired off the raw flag with no environment condition at all
 * while the verifier swap carried one.
 */
export function isMcpDevBypassAllowed(nodeEnv: string | undefined): boolean {
  return (MCP_DEV_BYPASS_ALLOWED_NODE_ENVS as readonly string[]).includes(nodeEnv ?? "");
}

export interface McpDevBypassFenceInput {
  nodeEnv: string | undefined;
  /** cfg.BRAIN_MCP_DEV_AUTH_BYPASS: true/false after Zod coercion. */
  devAuthBypass: boolean;
}

/**
 * Refuse to boot when the bypass is enabled outside the allowlist. Silent
 * (no-op) when the bypass is disabled, matching the other boot fences in
 * this directory -- most operators run here.
 */
export function assertMcpDevBypassFence(input: McpDevBypassFenceInput): void {
  if (!input.devAuthBypass) return;

  if (!isMcpDevBypassAllowed(input.nodeEnv)) {
    throw new Error(
      "BRAIN_MCP_DEV_AUTH_BYPASS=true is only allowed when NODE_ENV is " +
        `development or test (got ${input.nodeEnv ?? "undefined"}). The bypass ` +
        "replaces MCP auth with a hardcoded always-active agent and skips the " +
        "principal-type check on the MCP route -- refusing to start rather than " +
        "risk running it against a real database.",
    );
  }
}
