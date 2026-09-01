import type { ApiRequestMeterEvent } from "@brain/shared";

export const SHADOW_REQUEST_POLICY_VERSION = "requests_v1_shadow";

export interface MeteredRequestUnits {
  meteringPolicyVersion: typeof SHADOW_REQUEST_POLICY_VERSION;
  billableUnits: 0 | 1;
}

/**
 * Immutable RFC 0008 request-unit policy. It measures eligible production
 * traffic during shadow operation, but period close keeps chargeable units at
 * zero until a separately reviewed billable policy is introduced.
 */
export function classifyRequestUnits(event: ApiRequestMeterEvent): MeteredRequestUnits {
  const eligible =
    event.environment === "live" &&
    event.accessStage === "production" &&
    event.outcome === "success" &&
    event.statusCode >= 200 &&
    event.statusCode < 400;
  return {
    meteringPolicyVersion: SHADOW_REQUEST_POLICY_VERSION,
    billableUnits: eligible ? 1 : 0,
  };
}
