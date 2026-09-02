import { describe, expect, it } from "vitest";
import type { ApiRequestMeterEvent } from "@brain/shared";
import { classifyRequestUnits } from "./billing-policy.js";

const event = {
  environment: "live",
  accessStage: "production",
  outcome: "success",
  statusCode: 200,
} as ApiRequestMeterEvent;

describe("shadow request-unit policy", () => {
  it("counts successful live production requests without charging them", () => {
    expect(classifyRequestUnits(event)).toEqual({
      meteringPolicyVersion: "requests_v1_shadow",
      billableUnits: 1,
    });
  });

  it.each([
    { environment: "sandbox" as const },
    { accessStage: "demo" as const },
    { outcome: "client_error" as const, statusCode: 400 },
    { outcome: "server_error" as const, statusCode: 500 },
    { outcome: "rate_limited" as const, statusCode: 429 },
  ])("assigns zero units to nonbillable traffic: %o", (patch) => {
    expect(classifyRequestUnits({ ...event, ...patch })).toMatchObject({ billableUnits: 0 });
  });
});
