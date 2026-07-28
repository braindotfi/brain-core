/**
 * The pending-authorization blob (AUTH-PATHS-PLAN.md section 5): when
 * `GET /authorize` finds no valid AS session, it 302s to
 * `/login?continue=<blob>` carrying the original request so the login form
 * can resubmit it and land back on `/authorize` once authenticated.
 *
 * Same `mintHmacToken`/`verifyHmacToken` primitive as session.ts, with its
 * own `aud: "authorize_request"` for domain separation and a 10-minute TTL
 * per AUTH-PATHS-PLAN.md section 5. No storage: the entire pending request
 * rides in the token itself.
 */

import { mintHmacToken, verifyHmacToken, type VerifyHmacTokenResult } from "@brain/shared";

const PENDING_AUTHORIZATION_AUD = "authorize_request";
const PENDING_AUTHORIZATION_TTL_SECONDS = 10 * 60;

export interface PendingAuthorizationParams {
  readonly response_type: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scope: string;
  readonly state: string;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly resource: string;
}

export function mintPendingAuthorization(
  secret: string,
  params: PendingAuthorizationParams,
  nowMs = Date.now(),
): string {
  return mintHmacToken({
    secret,
    aud: PENDING_AUTHORIZATION_AUD,
    payload: params,
    ttlSeconds: PENDING_AUTHORIZATION_TTL_SECONDS,
    nowMs,
  }).token;
}

export function verifyPendingAuthorization(
  secret: string,
  token: string,
  nowMs = Date.now(),
): VerifyHmacTokenResult<PendingAuthorizationParams> {
  return verifyHmacToken<PendingAuthorizationParams>({
    token,
    secret,
    aud: PENDING_AUTHORIZATION_AUD,
    nowMs,
  });
}

/** Rebuilds `/authorize?...` from a verified pending-authorization payload. */
export function pendingAuthorizationToQueryString(params: PendingAuthorizationParams): string {
  return new URLSearchParams({ ...params }).toString();
}
