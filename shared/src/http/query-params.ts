/**
 * Strict parsers for optional HTTP query parameters (Fable-5 review F-2).
 *
 * `Number.parseInt(garbage)` is NaN and `new Date(garbage)` is Invalid Date;
 * both previously flowed into SQL (`LIMIT NaN`, an invalid timestamptz bind)
 * where Postgres rejected them and the caller saw a misleading
 * 500 internal_server_error. Malformed query input is the CALLER's error:
 * these helpers reject it with 400 request_params_invalid before any DB work.
 */

import { brainError } from "../errors.js";

/**
 * Parse an optional positive-integer query param (e.g. `?limit=`). Returns
 * `fallback` when absent; clamps to `max` (preserving the existing
 * cap-don't-reject behavior for large values); throws
 * `request_params_invalid` (400) for anything that is not a plain positive
 * whole number — `"abc"`, `"-5"`, `"0"`, `"3.5"`, `"1e9"`.
 */
export function parsePositiveIntParam(
  name: string,
  raw: string | undefined,
  opts: { fallback: number; max: number },
): number {
  if (raw === undefined) {
    return opts.fallback;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw brainError("request_params_invalid", `${name} must be a positive whole number`, {
      details: { [name]: raw },
    });
  }
  return Math.min(Number(trimmed), opts.max);
}

/**
 * Parse an optional timestamp query param (e.g. `?since=`). Returns undefined
 * when absent; throws `request_params_invalid` (400) when the value does not
 * parse to a valid date.
 */
export function parseDateParam(name: string, raw: string | undefined): Date | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw brainError("request_params_invalid", `${name} must be an ISO-8601 timestamp`, {
      details: { [name]: raw },
    });
  }
  return d;
}
