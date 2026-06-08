/**
 * Pure, tested input parsing for the audit-outbox operator CLI (Codex 307161b
 * P2 #3). Kept out of the thin entrypoint so the validation has unit coverage.
 *
 * A recovery CLI runs by hand under operator stress, so a fat-fingered
 * `--limit -1`, `--limit 1e9`, or `--older-than abc` must fail loudly with a
 * clear message instead of silently degrading to a NaN/huge SQL LIMIT that
 * replays far more (or far less) than intended.
 */

/** Env vars consulted, in order, for the build commit recorded in replay evidence. */
const SOURCE_COMMIT_ENV_VARS = [
  "BRAIN_BUILD_SHA",
  "GIT_COMMIT",
  "GIT_SHA",
  "SOURCE_COMMIT",
] as const;

/**
 * Parse a CLI integer flag, rejecting anything that is not a plain whole number
 * within `[min, max]`. Strict on purpose: only `^-?\d+$` is accepted, so
 * `"1e9"`, `"0x10"`, `"3.5"`, `"abc"`, and `""` are all rejected rather than
 * silently coerced by `Number(...)`.
 *
 * @throws Error with an operator-readable message on any invalid input.
 */
export function parseBoundedInt(
  flagName: string,
  raw: string,
  bounds: { min: number; max: number },
): number {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return fail(`--${flagName} must be a whole number, got ${JSON.stringify(raw)}`);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    return fail(`--${flagName} is out of integer range: ${JSON.stringify(raw)}`);
  }
  if (n < bounds.min || n > bounds.max) {
    return fail(`--${flagName} must be between ${bounds.min} and ${bounds.max}, got ${n}`);
  }
  return n;
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Resolve the source commit for replay evidence from the environment (first
 * non-empty wins). Returns undefined when none is set, so evidence simply omits
 * it rather than recording a misleading placeholder.
 */
export function resolveSourceCommit(env: Record<string, string | undefined>): string | undefined {
  for (const key of SOURCE_COMMIT_ENV_VARS) {
    const value = env[key];
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
