import { describe, expect, it } from "vitest";
import { assertOutboxDispatchGuardWiredInProduction } from "./outbox-dispatch-guard-fence.js";

describe("assertOutboxDispatchGuardWiredInProduction", () => {
  it("allows production when the execution worker has beforeDispatch configured", () => {
    expect(() =>
      assertOutboxDispatchGuardWiredInProduction({
        nodeEnv: "production",
        executionWorkerEnabled: true,
        beforeDispatchConfigured: true,
      }),
    ).not.toThrow();
  });

  it("fails production boot when execution worker lacks beforeDispatch", () => {
    expect(() =>
      assertOutboxDispatchGuardWiredInProduction({
        nodeEnv: "production",
        executionWorkerEnabled: true,
        beforeDispatchConfigured: false,
      }),
    ).toThrow(/beforeDispatch guard/);
  });

  it("allows non-production and production processes without the execution worker", () => {
    expect(() =>
      assertOutboxDispatchGuardWiredInProduction({
        nodeEnv: "test",
        executionWorkerEnabled: true,
        beforeDispatchConfigured: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertOutboxDispatchGuardWiredInProduction({
        nodeEnv: "production",
        executionWorkerEnabled: false,
        beforeDispatchConfigured: false,
      }),
    ).not.toThrow();
  });
});
